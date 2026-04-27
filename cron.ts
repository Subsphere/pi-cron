/**
 * Cron Extension - schedule prompts that fire on a wall-clock interval.
 *
 * A timer started at `session_start` ticks every CHECK_INTERVAL_MS. On each
 * tick we evaluate every loaded job's cron expression against the current
 * minute. When a job is due, we spawn a separate pi process (via the
 * extension API's safe spawn helper) using that job's own session file. Each
 * cron task is therefore a fully isolated conversation with its own memory
 * across runs.
 *
 *   tick fires for "morning-brief"
 *     ↓
 *   spawn: pi -p -c --session ~/.pi/cron-sessions/morning-brief-abc.jsonl "<prompt>"
 *     ↓
 *   subprocess loads yesterday's brief, day-before's, ...
 *   subprocess runs agent (with full per-task history)
 *   subprocess writes ~/briefs/today.md (per the prompt's instructions)
 *   subprocess saves new turn to morning-brief-abc.jsonl
 *   subprocess exits cleanly (exit 0)
 *     ↓
 *   extension records the fire in metadata log
 *
 * Your main pi session is never touched. Each cron task is a real,
 * persistent conversation you can later open interactively via /cron-open.
 *
 * # Trust model
 *
 * Two job sources, with very different trust levels:
 *
 *   - GLOBAL  (~/.pi/cron.d/)        - placed by the user. Trusted. Prompt
 *                                       paths can be ~/, absolute, or relative
 *                                       (resolved against the .cron file's dir).
 *   - LOCAL   (<cwd>/.pi/cron.d/)    - placed by *whoever wrote the repo*.
 *                                       Untrusted. Prompt paths must be
 *                                       repo-relative AND, after symlink
 *                                       resolution, still inside the repo.
 *                                       This blocks a malicious repo from
 *                                       saying `prompt: ~/.ssh/id_rsa` and
 *                                       silently exfiltrating it to the LLM
 *                                       provider when the cron fires.
 *
 * # State files (two distinct kinds)
 *
 *   ~/.pi/cron/${slug}-${hash}.jsonl
 *     Fire-log metadata (when each job last fired, dispatch history). Local-
 *     only - never sent to a model. Used for /cron listings + dedup window.
 *     Auto-compacts past MAX_JOB_HISTORY_LINES.
 *
 *   ~/.pi/cron-sessions/${slug}-${hash}.jsonl
 *     The actual pi session file for this cron task. Same format as your main
 *     pi session - holds the conversation history that the agent loads on
 *     each fire. This is real per-task memory.
 *
 * `${slug}` is the job's `name` sanitized to filename-safe characters.
 * `${hash}` is a short sha256 of the .cron config file's path. So a global
 * "ping" and a local "ping" never collide.
 *
 * # Recursion guard
 *
 * The subprocess pi we spawn would itself try to load this extension and
 * start scheduling. To prevent infinite recursion, we set
 * `PI_CRON_SUBPROCESS=1` in the subprocess env. The extension's session_start
 * handler checks for this and skips scheduling if set.
 *
 * # Cron config files
 *
 * Each `.cron` file defines exactly one job:
 *
 *   name: my-job
 *   prompt: prompts/my-job.md         # see trust model above
 *   cron: 0,30 * * * *                # every 30 minutes
 *   description: Brief description
 *
 * Cron format: minute hour day-of-month month day-of-week
 *   Field tokens: *, *\/N, N, N-N, N-N/N, N,M
 *   POSIX semantics: DOW 7 = 0 (Sunday); DOM/DOW use OR when both restricted.
 *
 * # Slash commands
 *
 *   /cron               - List registered jobs (source, last-fired, depth)
 *   /cron-remove <name> - Remove a job in-memory (returns on next session start)
 *   /cron-open <name>   - Print the command to open a task's session interactively
 */

import { createHash } from "node:crypto";
import {
	accessSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export type JobSource = "global" | "local";

export interface CronJob {
	name: string;
	promptPath: string;
	cronExpression: string;
	description?: string;
	/** Where this job came from - drives the prompt-path trust check. */
	source: JobSource;
	/** Absolute path to the .cron file. Used to key per-job state files. */
	configFile: string;
}

/** Subset used for state-file lookup; any CronJob qualifies. */
export type JobIdentity = Pick<CronJob, "name" | "configFile">;

/** Entry written to a job's per-job session JSONL file. */
export interface JobEntry {
	type: "fired" | "compaction_summary";
	prompt?: string;
	summary?: string;
	timestamp: string;
}

/** Result of resolving a job's prompt path. Either a usable path, or an error. */
export type PromptResolution = { ok: true; resolved: string } | { ok: false; error: string };

// ============================================================================
// Cron parsing
// ============================================================================

/**
 * Parse a single cron field into the set of integers it matches.
 * `max` is the EXCLUSIVE upper bound for `*` expansion (60 for minutes, 24
 * for hours, etc). Tokens supported: `*`, `N`, `N-M`, `N-M/S`, `*\/S`, `A,B,C`
 * and any comma-joined combination of those. Returns [] for unparseable input.
 */
export function parseCronField(field: string, max: number): number[] {
	const out = new Set<number>();
	for (const piece of field.split(",")) {
		const seg = piece.trim();
		if (!seg) continue;

		// Split off step suffix first so "1-10/2" and "*/15" both work.
		let rangeStr = seg;
		let step = 1;
		const slashIdx = seg.indexOf("/");
		if (slashIdx !== -1) {
			rangeStr = seg.slice(0, slashIdx);
			const stepN = Number.parseInt(seg.slice(slashIdx + 1), 10);
			if (!Number.isFinite(stepN) || stepN <= 0) continue;
			step = stepN;
		}

		let from: number;
		let to: number;
		if (rangeStr === "*") {
			from = 0;
			to = max - 1;
		} else if (rangeStr.includes("-")) {
			const [a, b] = rangeStr.split("-").map((s) => Number.parseInt(s, 10));
			if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
			from = a;
			to = b;
		} else {
			const n = Number.parseInt(rangeStr, 10);
			if (!Number.isFinite(n)) continue;
			from = n;
			to = n;
		}

		// Clamp to the field domain BEFORE iterating. Without this, an attacker-
		// controlled .cron file with `0-1000000000/1` would loop a billion times
		// then filter, pinning the session every minute. (codex round-3 finding.)
		const fromClamped = Math.max(0, from);
		const toClamped = Math.min(max - 1, to);
		if (toClamped < fromClamped) continue;
		for (let v = fromClamped; v <= toClamped; v += step) {
			out.add(v);
		}
	}
	return [...out].sort((a, b) => a - b);
}

/**
 * True iff `now` falls in the minute described by the 5-field cron expression.
 *
 * POSIX-cron semantics: when BOTH day-of-month and day-of-week are restricted
 * (neither is `*`), the expression matches if EITHER matches (OR). When at
 * least one is `*`, both must match (AND, equivalent to ignoring the `*`).
 *
 * DOW: `7` is normalized to `0` (Sunday) per the standard cron extension.
 */
export function matchesCron(expression: string, now: Date): boolean {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) return false;

	const minutes = parseCronField(parts[0], 60);
	const hours = parseCronField(parts[1], 24);
	// Days of month are 1..31; expand 0..32 then filter against getDate().
	const days = parseCronField(parts[2], 32);
	// Months are 1..12; expand 0..13 then filter against getMonth()+1.
	const months = parseCronField(parts[3], 13);
	// DOW domain is 0..7 where both 0 and 7 mean Sunday. Parse with max=8 to
	// admit `7`, then normalize 7→0 and dedupe.
	const dowRaw = parseCronField(parts[4], 8);
	const dow = [...new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);

	if (!minutes.includes(now.getMinutes())) return false;
	if (!hours.includes(now.getHours())) return false;
	if (!months.includes(now.getMonth() + 1)) return false;

	const domMatch = days.includes(now.getDate());
	const dowMatch = dow.includes(now.getDay());
	const domRestricted = parts[2].trim() !== "*";
	const dowRestricted = parts[4].trim() !== "*";

	if (domRestricted && dowRestricted) {
		// POSIX cron OR: matches if either constraint is satisfied.
		return domMatch || dowMatch;
	}
	// Standard AND: at least one is `*` so it admits everything for that field.
	return domMatch && dowMatch;
}

// ============================================================================
// Job loading
// ============================================================================

/**
 * Parse a `.cron` file. `source` and the absolute file path are stamped onto
 * the resulting job so downstream code can apply trust + collision rules.
 *
 * Returns null on any failure (missing file, EACCES, directory passed as
 * filePath, malformed content, missing required field). Never throws. This
 * matters because one bad `.cron` entry must not abort `loadAllJobs()` and
 * leave the whole scheduler dark for the session. (codex round-6 finding.)
 */
export function loadCronFile(filePath: string, source: JobSource): CronJob | null {
	if (!existsSync(filePath)) return null;

	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		// Directory at this path, EACCES, broken symlink, non-utf8 bytes, etc.
		return null;
	}

	let name: string | undefined;
	let promptPath: string | undefined;
	let cronExpression: string | undefined;
	let description: string | undefined;

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;

		const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
		const value = trimmed.slice(colonIdx + 1).trim();

		if (key === "name") name = value;
		else if (key === "prompt") promptPath = value;
		else if (key === "cron") cronExpression = value;
		else if (key === "description") description = value;
	}

	if (!name || !promptPath || !cronExpression) return null;
	return { name, promptPath, cronExpression, description, source, configFile: filePath };
}

function findCronFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		// withFileTypes lets us drop directories and special files BEFORE we try
		// to read them. A directory like `mydir.cron` would otherwise crash the
		// loader on readFileSync.
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith(".cron"))
			.map((d) => join(dir, d.name));
	} catch {
		return [];
	}
}

/** Returns all `.cron` config file paths, tagged by source. */
export function discoverCronFiles(homeDir: string, cwdDir: string): { path: string; source: JobSource }[] {
	const out: { path: string; source: JobSource }[] = [];
	for (const f of findCronFiles(join(homeDir, ".pi", "cron.d"))) out.push({ path: f, source: "global" });
	for (const f of findCronFiles(join(cwdDir, ".pi", "cron.d"))) out.push({ path: f, source: "local" });
	return out;
}

export function loadAllJobs(homeDir: string, cwdDir: string): CronJob[] {
	const out: CronJob[] = [];
	for (const { path, source } of discoverCronFiles(homeDir, cwdDir)) {
		const job = loadCronFile(path, source);
		if (job) out.push(job);
	}
	return out;
}

// ============================================================================
// Per-job session file (state + history + auto-compaction)
//
// State files are keyed by ${name}-${sha256(configFile).slice(0,10)}.jsonl so
// a global "ping" and a local "ping" never share state. This was a real bug
// before we added the hash suffix - the dedup window of one job would silently
// suppress the other.
// ============================================================================

const DEFAULT_STATE_DIR = join(homedir() || "", ".pi", "cron");
export const MAX_JOB_HISTORY_LINES = 200;
export const COMPACTION_KEEP = 50;

export function configHash(configFile: string): string {
	return createHash("sha256").update(configFile).digest("hex").slice(0, 10);
}

/**
 * Slug a job name into something safe for use as a filename component.
 *
 * Anything outside [a-zA-Z0-9_-] becomes "_". Without this, an untrusted
 * local `.cron` file with `name: ../../.ssh/cronjunk` would let
 * `getJobSessionPath()` produce a path that escapes ~/.pi/cron when
 * interpolated into `path.join`. The configHash suffix already makes the
 * filename unique per source file - the slug is purely about path-safety.
 * (codex round-3 finding.)
 */
export function safeNameSlug(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	return sanitized.length > 0 ? sanitized : "_anonymous";
}

export function getJobSessionPath(job: JobIdentity, baseDir: string = DEFAULT_STATE_DIR): string {
	const filename = `${safeNameSlug(job.name)}-${configHash(job.configFile)}.jsonl`;
	const candidate = join(baseDir, filename);
	// Defense in depth: confirm the joined path stays inside baseDir even if
	// some future change to safeNameSlug regresses. relative() returns a
	// relative path; if the candidate escapes, it begins with ".." or becomes
	// absolute on Windows.
	const rel = relative(baseDir, candidate);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`cron state path escaped baseDir (job.name="${job.name}", candidate=${candidate})`);
	}
	return candidate;
}

/**
 * Default directory for per-task pi session files. Distinct from DEFAULT_STATE_DIR
 * (which holds metadata-only fire logs). Each task's session file is a real pi
 * conversation - same .jsonl format as your interactive sessions - that the cron
 * subprocess loads and continues on each fire.
 */
const DEFAULT_SESSION_DIR = join(homedir() || "", ".pi", "cron-sessions");

/**
 * Path to the per-task pi session file. Same name+hash slug as the fire log,
 * different directory. Containment-checked the same way to defeat a malicious
 * job-name traversal.
 */
export function getTaskSessionPath(job: JobIdentity, baseDir: string = DEFAULT_SESSION_DIR): string {
	const filename = `${safeNameSlug(job.name)}-${configHash(job.configFile)}.jsonl`;
	const candidate = join(baseDir, filename);
	const rel = relative(baseDir, candidate);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`cron task session path escaped baseDir (job.name="${job.name}", candidate=${candidate})`);
	}
	return candidate;
}

export function loadJobHistory(job: JobIdentity, baseDir: string = DEFAULT_STATE_DIR): JobEntry[] {
	const path = getJobSessionPath(job, baseDir);
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as JobEntry);
	} catch {
		return [];
	}
}

export function appendJobMessage(job: JobIdentity, prompt: string, baseDir: string = DEFAULT_STATE_DIR): void {
	const path = getJobSessionPath(job, baseDir);
	mkdirSync(dirname(path), { recursive: true });
	const entry: JobEntry = { type: "fired", prompt, timestamp: new Date().toISOString() };
	writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

/** Compact the job's history if it exceeds `maxLines`. Returns the post-compaction array. */
export function compactJobHistory(
	job: JobIdentity,
	baseDir: string = DEFAULT_STATE_DIR,
	maxLines: number = MAX_JOB_HISTORY_LINES,
	keepCount: number = COMPACTION_KEEP,
): JobEntry[] {
	const entries = loadJobHistory(job, baseDir);
	if (entries.length <= maxLines) return entries;

	const recent = entries.slice(-keepCount);
	const old = entries.slice(0, -keepCount);
	const fires = old.filter((e) => e.type === "fired");
	const summary: JobEntry = {
		type: "compaction_summary",
		summary: `[COMPACTED ${old.length} entries, ${fires.length} fires from ${fires[0]?.timestamp ?? "?"} to ${fires.at(-1)?.timestamp ?? "?"}]`,
		timestamp: new Date().toISOString(),
	};

	const compacted = [summary, ...recent];
	const path = getJobSessionPath(job, baseDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${compacted.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return compacted;
}

export function getLastFireTime(job: JobIdentity, baseDir: string = DEFAULT_STATE_DIR): number | null {
	const entries = loadJobHistory(job, baseDir);
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "fired") return new Date(entries[i].timestamp).getTime();
	}
	return null;
}

export function getJobEntryCount(job: JobIdentity, baseDir: string = DEFAULT_STATE_DIR): number {
	return loadJobHistory(job, baseDir).length;
}

// ============================================================================
// Firing decision
// ============================================================================

export const DEFAULT_DEDUP_WINDOW_MS = 60_000;

// ----------------------------------------------------------------------------
// Catch-up scheduler
//
// The naive "evaluate matchesCron at callback time" strategy silently misses
// any minute boundary that the timer drifts past (laptop sleep, event-loop
// stall, session_start at HH:00:05 etc). The catch-up scheduler walks back
// minute-by-minute from `now` to the most recent matching minute, bounded by
// (a) the job's last-fire timestamp (no double-fire) and (b) a perf cap.
//
// For never-fired jobs we use a much shorter floor (FIRST_TIME_LOOKBACK_MS)
// and don't go before extensionLoadMs - we don't want to dredge up a stale
// schedule from before the extension loaded and surprise the user.
// (codex round-6 finding.)
// ----------------------------------------------------------------------------

export const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h: covers daily crons across overnight sleep
export const FIRST_TIME_LOOKBACK_MS = 5 * 60 * 1000; // 5m: covers "opened pi a few seconds late"

/** Floor a Date to the start of its minute. */
export function floorToMinute(d: Date): Date {
	const f = new Date(d);
	f.setSeconds(0, 0);
	return f;
}

/**
 * Find the most recent minute (≤ now) where the job's cron expression matches
 * AND the dedup/lookback bounds permit firing. Returns null if no such minute
 * exists in the allowed window. Pure - easy to unit-test against synthetic clocks.
 *
 * Lower-bound logic:
 *   - never-fired job: max(now - 5min, extensionLoadMs) - small catch-up only
 *   - previously-fired:  max(now - 24h, lastFire + dedup) - perf cap + dedup
 */
export function findMostRecentDueMinute(
	job: CronJob,
	now: Date,
	lastFireMs: number | null,
	extensionLoadMs: number,
	dedupWindowMs: number = DEFAULT_DEDUP_WINDOW_MS,
): Date | null {
	const nowMs = now.getTime();
	let lowerBoundMs: number;
	if (lastFireMs !== null) {
		lowerBoundMs = Math.max(nowMs - MAX_LOOKBACK_MS, lastFireMs + dedupWindowMs);
	} else {
		lowerBoundMs = Math.max(nowMs - FIRST_TIME_LOOKBACK_MS, extensionLoadMs);
	}
	if (lowerBoundMs > nowMs) return null;

	let cursor = floorToMinute(now);
	while (cursor.getTime() >= lowerBoundMs) {
		if (matchesCron(job.cronExpression, cursor)) return cursor;
		cursor = new Date(cursor.getTime() - 60_000);
	}
	return null;
}

/**
 * Default context-usage cap for pi's main session. When a cron fires and the
 * session's token usage exceeds this, the extension calls `ctx.compact()` so
 * pi shrinks the session before the cron's contribution accumulates further.
 *
 * Default: 100,000 tokens. On a 262K-context local model this leaves 162K of
 * headroom for the user's interactive work. Override at the top of cron.ts
 * if you want a different ceiling, or set 0 to disable compaction entirely.
 *
 * Cap is checked AFTER each cron fire so the cron's prompt always reaches
 * the model first. Compaction itself is async (fire-and-forget) and runs in
 * the background between cron ticks.
 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;

/**
 * Pure decision: should we trigger pi's compaction right now? Easy unit test.
 *   - usage missing       → false (no signal)
 *   - usage.tokens null   → false (just compacted, pi hasn't re-counted yet)
 *   - maxTokens <= 0      → false (user disabled the cap)
 *   - tokens > maxTokens  → true
 */
export function shouldCompactContext(usage: ContextUsage | undefined, maxTokens: number): boolean {
	if (maxTokens <= 0) return false;
	if (!usage || usage.tokens == null) return false;
	return usage.tokens > maxTokens;
}

/** Decide whether a job is due to fire right now. Pure function - easy to unit-test. */
export function shouldFire(
	job: CronJob,
	now: Date,
	lastFireMs: number | null,
	dedupWindowMs: number = DEFAULT_DEDUP_WINDOW_MS,
): boolean {
	if (!matchesCron(job.cronExpression, now)) return false;
	if (lastFireMs !== null && now.getTime() - lastFireMs < dedupWindowMs) return false;
	return true;
}

// ============================================================================
// Prompt-path resolution + safety check
// ============================================================================

/**
 * Validate and canonicalize a project-local prompt path.
 *
 * Rules (any failure rejects with a specific error):
 *   - no leading ~ (would let an attacker read $HOME)
 *   - no absolute paths (would let an attacker read anywhere)
 *   - file must exist (we realpath it)
 *   - canonical path must be inside the repo's canonical cwd
 *
 * The realpath check transparently handles symlink-based escapes: if the
 * supplied path is a symlink (or contains symlinked path segments) that
 * resolve outside the repo, the relative-path check rejects.
 */
export function validateLocalPromptPath(promptPath: string, cwdDir: string): PromptResolution {
	if (promptPath.startsWith("~")) {
		return { ok: false, error: `project-local cron prompts cannot use ~ paths (got "${promptPath}")` };
	}
	if (isAbsolute(promptPath)) {
		return { ok: false, error: `project-local cron prompts cannot use absolute paths (got "${promptPath}")` };
	}

	let cwdReal: string;
	try {
		cwdReal = realpathSync(cwdDir);
	} catch {
		return { ok: false, error: `cwd not accessible: ${cwdDir}` };
	}

	const joined = join(cwdDir, promptPath);
	let canonical: string;
	try {
		canonical = realpathSync(joined);
	} catch {
		return { ok: false, error: `prompt file not found: ${promptPath}` };
	}

	const rel = relative(cwdReal, canonical);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		return {
			ok: false,
			error: `project-local prompts cannot resolve outside the repo (${promptPath} → ${canonical})`,
		};
	}
	return { ok: true, resolved: canonical };
}

/**
 * Resolve a global (trusted) prompt path. Allows ~/, absolute, and relative
 * forms. Relative paths resolve against `configFileDir` (the directory the
 * `.cron` file lives in), NOT against the session cwd - resolving against cwd
 * would let any opened repo plant a same-named file and hijack a globally
 * trusted cron. (codex round-4 finding.)
 */
export function resolveGlobalPromptPath(promptPath: string, configFileDir: string, homeDir: string): string {
	if (promptPath.startsWith("~/")) return join(homeDir, promptPath.slice(2));
	if (isAbsolute(promptPath)) return promptPath;
	return join(configFileDir, promptPath);
}

/**
 * Confirm the path is a readable regular file. Rejects directories, FIFOs,
 * sockets, devices, and EACCES. Without this check, `readFileSync` on a
 * directory or FIFO would throw out of the timer callback and could take
 * the session down. (codex round-2 finding.)
 */
export function isReadableRegularFile(p: string): { ok: true } | { ok: false; reason: string } {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(p);
	} catch (err) {
		return { ok: false, reason: `stat failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!stat.isFile()) {
		return { ok: false, reason: "not a regular file (got directory or special file)" };
	}
	try {
		accessSync(p, fsConstants.R_OK);
	} catch {
		return { ok: false, reason: "not readable" };
	}
	return { ok: true };
}

/** Top-level: returns either a usable path or a human-readable error. */
export function resolveJobPrompt(job: CronJob, cwdDir: string, homeDir: string): PromptResolution {
	let basic: PromptResolution;
	if (job.source === "local") {
		basic = validateLocalPromptPath(job.promptPath, cwdDir);
	} else {
		// Global jobs resolve relative paths against the config file's directory,
		// not the session cwd. Otherwise an opened repo could shadow a trusted
		// global cron's prompt file with its own.
		const resolved = resolveGlobalPromptPath(job.promptPath, dirname(job.configFile), homeDir);
		basic = existsSync(resolved)
			? { ok: true, resolved }
			: { ok: false, error: `prompt file not found: ${resolved}` };
	}
	if (!basic.ok) return basic;
	const fileCheck = isReadableRegularFile(basic.resolved);
	if (!fileCheck.ok) return { ok: false, error: `prompt path is ${fileCheck.reason}: ${basic.resolved}` };
	return basic;
}

// ============================================================================
// Dispatch preparation (pure, testable)
// ============================================================================

export type PrepareResult =
	| { ok: true; resolved: string; promptContent: string; tagged: string }
	| { ok: false; reason: string };

/**
 * Resolve + read + tag a job's prompt. All side effects are reads. The result
 * either contains a fully-formed message ready to dispatch, or a reason the
 * dispatch should be skipped. checkAndFireJobs() composes this with the
 * actual sendUserMessage call so failures here can't escape the timer
 * callback - the worst case is `notify(reason, "error")` and continue.
 */
export function prepareCronDispatch(job: CronJob, cwdDir: string, homeDir: string): PrepareResult {
	const r = resolveJobPrompt(job, cwdDir, homeDir);
	if (!r.ok) return { ok: false, reason: r.error };
	let promptContent: string;
	try {
		promptContent = readFileSync(r.resolved, "utf-8").trim();
	} catch (err) {
		return { ok: false, reason: `failed to read prompt: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!promptContent) return { ok: false, reason: "prompt file is empty" };
	return { ok: true, resolved: r.resolved, promptContent, tagged: `[cron: ${job.name}]\n${promptContent}` };
}

// ============================================================================
// Subprocess args (pure helper - testable)
// ============================================================================

/**
 * Build the argv for spawning a pi subprocess to run a cron task.
 *
 * Layout:
 *   pi --no-extensions -p -c --session <task-session> "<tagged-prompt>"
 *
 * Flag-by-flag rationale:
 *   --no-extensions  prevents the spawned pi from auto-loading THIS extension
 *                    and recursing. Built-in tools (bash, write, edit, read)
 *                    still work, which covers all realistic cron use cases.
 *   -p               print mode: process the prompt, write response to stdout,
 *                    exit. The cron extension itself ignores stdout - the
 *                    cron's prompt is responsible for any side effects (file
 *                    writes, curl, etc.). This is what keeps the user's main
 *                    TUI undisturbed.
 *   -c               continue the session at --session: load prior turns into
 *                    context. This is what gives each cron task its own real
 *                    persistent memory across runs.
 *   --session <path> the per-task session file. Each cron task has its own.
 *
 * The prompt content is passed as the last positional arg.
 */
export function buildSubprocessArgs(taskSessionPath: string, taggedPrompt: string): string[] {
	return ["--no-extensions", "-p", "-c", "--session", taskSessionPath, taggedPrompt];
}

// ============================================================================
// Extension entry point
// ============================================================================

const CHECK_INTERVAL_MS = 60_000;
const SUBPROCESS_TIMEOUT_MS = 10 * 60 * 1000; // 10 min: kills hung subprocess so the next tick can retry

export default async function (pi: ExtensionAPI): Promise<void> {
	let jobs: CronJob[] = [];
	let lastCtx: ExtensionContext | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let cwdDir = process.cwd();
	let extensionLoadMs = Date.now();
	let isCheckRunning = false;
	const homeDir = homedir() || "";
	const stateDir = join(homeDir, ".pi", "cron");
	const sessionDir = join(homeDir, ".pi", "cron-sessions");

	/**
	 * Dispatch a single due job by spawning a pi subprocess on the job's own
	 * per-task session file. Returns true iff the subprocess exited 0 AND we
	 * persisted the fire log.
	 *
	 * Ordering rule: we persist the fire AFTER the subprocess exits 0. If the
	 * subprocess fails (non-zero exit, throw, timeout), we do NOT persist.
	 * Next tick will retry within the dedup window. For sparse schedules
	 * (daily) the catch-up logic handles the retry.
	 *
	 * Crash safety: the outer checkAndFireJobs wraps this in try/catch so any
	 * unforeseen throw never escapes the setInterval callback.
	 */
	async function fireOneJob(job: CronJob, matchedAt: Date, ctx: ExtensionContext): Promise<boolean> {
		const prep = prepareCronDispatch(job, cwdDir, homeDir);
		if (!prep.ok) {
			if (ctx.hasUI) ctx.ui.notify(`Cron "${job.name}": ${prep.reason}`, "error");
			return false;
		}

		const taskSessionPath = getTaskSessionPath(job, sessionDir);
		try {
			mkdirSync(dirname(taskSessionPath), { recursive: true });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) ctx.ui.notify(`Cron "${job.name}": cannot create session dir: ${msg}`, "error");
			return false;
		}

		const args = buildSubprocessArgs(taskSessionPath, prep.tagged);

		if (ctx.hasUI) {
			ctx.ui.notify(`Cron firing: ${job.name} [${job.source}] for ${matchedAt.toISOString()}`, "info");
		}

		let result: { stdout: string; stderr: string; code: number; killed: boolean };
		try {
			result = await pi.exec("pi", args, {
				cwd: cwdDir,
				signal: ctx.signal,
				timeout: SUBPROCESS_TIMEOUT_MS,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) ctx.ui.notify(`Cron "${job.name}": spawn threw: ${msg}`, "error");
			return false;
		}

		if (result.killed) {
			if (ctx.hasUI) ctx.ui.notify(`Cron "${job.name}": subprocess killed (timeout or abort)`, "warning");
			return false;
		}

		if (result.code !== 0) {
			const stderrSnip = (result.stderr || "(empty)").slice(0, 500).trim();
			if (ctx.hasUI) {
				ctx.ui.notify(`Cron "${job.name}": pi exited ${result.code}. stderr: ${stderrSnip}`, "error");
			}
			return false;
		}

		// Subprocess succeeded. Persist the fire log so dedup engages and
		// /cron listings show this run.
		try {
			compactJobHistory(job, stateDir);
			appendJobMessage(job, prep.promptContent, stateDir);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) {
				ctx.ui.notify(`Cron "${job.name}": fired but state persist failed: ${msg}`, "warning");
			}
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`Cron fired: ${job.description || job.name} [${job.source}]`, "info");
		}
		return true;
	}

	/**
	 * One scheduler tick. Iterates all jobs, awaiting each subprocess
	 * sequentially. Re-entry guard: if a previous tick is still running (e.g.,
	 * a cron job took 90 seconds), the next tick is skipped entirely.
	 */
	async function checkAndFireJobs(): Promise<void> {
		if (isCheckRunning) return;
		isCheckRunning = true;
		try {
			const ctx = lastCtx;
			if (!ctx) return;
			const now = new Date();
			for (const job of jobs) {
				try {
					const lastFire = getLastFireTime(job, stateDir);
					const matchedAt = findMostRecentDueMinute(job, now, lastFire, extensionLoadMs);
					if (!matchedAt) continue;
					await fireOneJob(job, matchedAt, ctx);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (ctx.hasUI) ctx.ui.notify(`Cron "${job.name}": dispatch failed: ${msg}`, "error");
				}
			}
		} finally {
			isCheckRunning = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;

		// Recursion guard. Two complementary protections, either alone is
		// sufficient. Belt-and-suspenders because the cost of an infinite
		// recursive spawn is severe.
		//
		//   1. We pass --no-extensions when spawning, so the subprocess does
		//      not load this extension at all (primary defense).
		//   2. PI_CRON_SUBPROCESS=1 in the env. The extension API doesn't let
		//      us set env via pi.exec, so this only fires for the
		//      pi-cron-runner CLI (which uses node:child_process directly).
		//      It also catches manual reproduction (`PI_CRON_SUBPROCESS=1
		//      pi`) and any future code path that wants to opt out.
		//
		// If we are inside a subprocess, do nothing - no jobs loaded, no timer
		// started. The subprocess just runs its prompt and exits.
		if (process.env.PI_CRON_SUBPROCESS === "1") {
			return;
		}

		cwdDir = ctx.cwd;
		extensionLoadMs = Date.now();
		jobs = loadAllJobs(homeDir, cwdDir);

		if (timer) clearInterval(timer);
		// setInterval ignores returned promises - which is fine because we have
		// our own re-entry guard via isCheckRunning. The scheduler ticks every
		// CHECK_INTERVAL_MS regardless of whether the previous tick finished.
		timer = setInterval(() => {
			void checkAndFireJobs();
		}, CHECK_INTERVAL_MS);
		// We do NOT call checkAndFireJobs() here. Earlier versions did to "catch
		// up" jobs whose matching minute coincided with session_start, but in
		// print mode this races with pi's own user-message dispatch. The first
		// timer tick lands within ≤60s, and findMostRecentDueMinute will catch
		// up any matching minute that drifted past session_start - so this
		// delay doesn't lose schedules, it just defers the first fire by ≤1
		// minute.

		if (ctx.hasUI) {
			const globalCount = jobs.filter((j) => j.source === "global").length;
			const localCount = jobs.filter((j) => j.source === "local").length;
			ctx.ui.notify(
				`Cron extension loaded: ${jobs.length} job(s) (${globalCount} global, ${localCount} local).`,
				"info",
			);

			// Surface .cron files that failed to load so a malformed entry doesn't
			// vanish silently. (codex round-6 finding.)
			const allDiscovered = discoverCronFiles(homeDir, cwdDir);
			const loadedConfigFiles = new Set(jobs.map((j) => j.configFile));
			const failedPaths = allDiscovered.filter((d) => !loadedConfigFiles.has(d.path)).map((d) => d.path);
			if (failedPaths.length > 0) {
				ctx.ui.notify(
					`Cron: ${failedPaths.length} .cron file(s) failed to load (missing required field, unreadable, or malformed): ${failedPaths.join(", ")}`,
					"warning",
				);
			}
		}
	});

	// Refresh ctx on every event we care about so isIdle() reflects current state
	// when the timer-driven checkAndFireJobs() runs.
	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
	});
	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	});

	pi.registerCommand("cron", {
		description: "List registered cron jobs (source, schedule, last-fired, fire count, session file presence)",
		handler: async (_args, ctx) => {
			if (jobs.length === 0) {
				ctx.ui.notify("No cron jobs. Add .cron files to ~/.pi/cron.d/ or .pi/cron.d/", "warning");
				return;
			}
			const lines: string[] = [];
			for (const job of jobs) {
				const last = getLastFireTime(job, stateDir);
				const when = last ? new Date(last).toLocaleString() : "never";
				const depth = getJobEntryCount(job, stateDir);
				const desc = job.description ? ` - ${job.description}` : "";
				const taskSession = getTaskSessionPath(job, sessionDir);
				const sessionExists = existsSync(taskSession) ? "✓" : "✗";
				lines.push(
					`[${job.source}] ${job.name}  cron: ${job.cronExpression}${desc}  (last: ${when}, ${depth} fires, session: ${sessionExists})`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("cron-open", {
		description: "Print the command to open a cron task's session interactively",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /cron-open <job-name>", "warning");
				return;
			}
			const job = jobs.find((j) => j.name === name);
			if (!job) {
				ctx.ui.notify(`Job "${name}" not found`, "error");
				return;
			}
			const taskSession = getTaskSessionPath(job, sessionDir);
			if (!existsSync(taskSession)) {
				ctx.ui.notify(`Session file does not exist yet (job hasn't fired): ${taskSession}`, "warning");
				return;
			}
			ctx.ui.notify(
				`To open this cron's session interactively, run in a new terminal:\n\n  pi --session ${taskSession}\n\nThe session contains the full conversation history accumulated across cron fires.`,
				"info",
			);
		},
	});

	pi.registerCommand("cron-remove", {
		description: "Remove a cron job in-memory (config file remains on disk; clears fire log + per-task session)",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /cron-remove <job-name>", "warning");
				return;
			}
			const idx = jobs.findIndex((j) => j.name === name);
			if (idx === -1) {
				ctx.ui.notify(`Job "${name}" not found`, "error");
				return;
			}
			const job = jobs[idx];
			jobs.splice(idx, 1);

			// Clear the fire-log metadata.
			const fireLog = getJobSessionPath(job, stateDir);
			if (existsSync(fireLog)) {
				try {
					writeFileSync(fireLog, "");
				} catch {
					/* ignore */
				}
			}
			// Note: we deliberately do NOT delete the per-task session file
			// (sessionDir/<slug>.jsonl). That contains the actual conversation
			// history the user might still want to read. Removing the cron job
			// config doesn't delete the chat. The user can rm it manually if
			// they want a clean slate.
			ctx.ui.notify(
				`Removed cron job: ${name} [${job.source}]. Fire log cleared. Per-task session file (${getTaskSessionPath(job, sessionDir)}) preserved - delete manually if you want a clean slate.`,
				"info",
			);
		},
	});
}
