/**
 * Cron Extension - schedule prompts that fire on a wall-clock interval.
 *
 * A timer started at `session_start` ticks every CHECK_INTERVAL_MS. On each
 * tick we evaluate every loaded job's cron expression against the current
 * minute and dispatch a prompt via `pi.sendUserMessage(...)`. This means jobs
 * fire even when the user isn't actively interacting with pi (true idle), not
 * just after an agent run completes.
 *
 * # Trust model
 *
 * Two job sources, with very different trust levels:
 *
 *   - GLOBAL  (~/.pi/cron.d/)        - placed by the user. Trusted. Prompt
 *                                       paths can be ~/, absolute, or relative.
 *   - LOCAL   (<cwd>/.pi/cron.d/)    - placed by *whoever wrote the repo*.
 *                                       Untrusted. Prompt paths must be
 *                                       repo-relative AND, after symlink
 *                                       resolution, still inside the repo.
 *                                       This blocks a malicious repo from
 *                                       saying `prompt: ~/.ssh/id_rsa` and
 *                                       silently exfiltrating it to the LLM
 *                                       provider when the cron fires.
 *
 * # State files
 *
 * Each job has its own JSONL log under `~/.pi/cron/${name}-${hash}.jsonl`,
 * where `hash` is a short sha256 of the source config file path. This means
 * a global "ping" and a local "ping" never share state - they get separate
 * dedup windows and separate history. The log auto-compacts past
 * MAX_JOB_HISTORY_LINES.
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
 *
 * # Slash commands
 *
 *   /cron            - List registered jobs (with source, last-fired, depth)
 *   /cron-remove N   - Remove a job in-memory (returns on next session start)
 *
 * # Context budget (notification only)
 *
 * After each cron fire, the extension checks pi's session usage. If usage
 * exceeds DEFAULT_MAX_CONTEXT_TOKENS (100K by default) it WARNS the user.
 * It does not auto-compact, because pi's compaction is governed by the
 * `keepRecentTokens` setting (default 20K) and extensions can't override it
 * per-call. Auto-compacting would shrink the session to ~25-30K, losing more
 * context than the user wanted to keep.
 *
 * To use the cap effectively: set `compaction.keepRecentTokens: 80000` in
 * your pi settings, then run /compact yourself when the cron warns you. The
 * compacted session will land at ~80K, in your target range.
 *
 * Set DEFAULT_MAX_CONTEXT_TOKENS to 0 to disable the warning.
 *
 * Note that the per-task `~/.pi/cron/${name}-${hash}.jsonl` log is purely
 * local metadata (last-fired times, fire history). It is NEVER sent to the
 * model. The only thing each cron fire adds to the model context is the
 * prompt file's contents.
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
 */
export function loadCronFile(filePath: string, source: JobSource): CronJob | null {
	if (!existsSync(filePath)) return null;

	const content = readFileSync(filePath, "utf-8");
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
		return readdirSync(dir)
			.filter((f) => f.endsWith(".cron"))
			.map((f) => join(dir, f));
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
// Extension entry point
// ============================================================================

const CHECK_INTERVAL_MS = 60_000;

export default async function (pi: ExtensionAPI): Promise<void> {
	let jobs: CronJob[] = [];
	let lastCtx: ExtensionContext | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let cwdDir = process.cwd();
	const homeDir = homedir() || "";
	const stateDir = join(homeDir, ".pi", "cron");

	/**
	 * Dispatch a single due job. Returns true if a sendUserMessage call was made.
	 *
	 * Crash safety: the caller wraps this in try/catch so any unforeseen throw
	 * just aborts this one job and notifies the user, instead of escaping the
	 * setInterval callback.
	 *
	 * Send-then-persist ordering: we ONLY append to the fire log after
	 * sendUserMessage returns without throwing. If delivery fails, the job
	 * stays "not fired" and the next tick will retry. This matters for daily
	 * crons where a missed window is invisible to the user otherwise.
	 *
	 * State-persist failure is treated as a soft warning - the message was
	 * already delivered, so the only consequence is that the next tick may
	 * re-fire (better than silently missing).
	 */
	function fireOneJob(job: CronJob, now: Date, ctx: ExtensionContext, alreadyDispatched: boolean): boolean {
		const lastFire = getLastFireTime(job, stateDir);
		if (!shouldFire(job, now, lastFire)) return false;

		// Preflight: skip if no model is configured. sendUserMessage is fire-
		// and-forget, so without this preflight a missing model would cause
		// the cron to be silently logged as fired despite the message never
		// reaching an LLM. This catches the most common configuration-error
		// case; the broader API limitation is documented above.
		if (!ctx.model) {
			if (ctx.hasUI) ctx.ui.notify(`Cron "${job.name}": skipped (no model selected)`, "warning");
			return false;
		}

		const prep = prepareCronDispatch(job, cwdDir, homeDir);
		if (!prep.ok) {
			if (ctx.hasUI) ctx.ui.notify(`Cron "${job.name}": ${prep.reason}`, "error");
			return false;
		}

		// Send first - if this throws we want to NOT have persisted the fire.
		//
		// LIMITATION: pi.sendUserMessage(...) returns void and is fire-and-
		// forget at the API level. We catch synchronous throws (e.g. "agent
		// busy" rejections) by NOT persisting the fire if this call throws.
		// But asynchronous failures (rate-limit, auth error, network failure
		// after queueing) are not visible here - the user message was queued
		// but may never reach the model. A complete fix needs a pending-state
		// log plus correlation against a delivery-confirmation event; out of
		// scope for this example extension.
		if (!alreadyDispatched && ctx.isIdle()) {
			pi.sendUserMessage(prep.tagged);
		} else {
			pi.sendUserMessage(prep.tagged, { deliverAs: "followUp" });
		}

		// Persist fire history (best effort - if state dir is unwritable we still
		// notify but consider the job dispatched, since the message went out).
		try {
			compactJobHistory(job, stateDir);
			appendJobMessage(job, prep.promptContent, stateDir);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) {
				ctx.ui.notify(`Cron "${job.name}": fired but state persist failed: ${msg}`, "warning");
			}
		}

		// Context cap: WARN, don't auto-compact.
		//
		// pi's compaction is governed by the `keepRecentTokens` setting (default
		// 20K). The extension API does NOT let us override that per-call - the
		// `customInstructions` option only shapes the summary text, not the cut
		// point. So if we called ctx.compact() here when the user's pi settings
		// still default to 20K, we'd shrink their session to ~25-30K and lose
		// most of the context they wanted to keep.
		//
		// Instead we just notify when usage exceeds the cap. The user can then:
		//   (a) raise pi's `keepRecentTokens` (e.g. 80000) in settings, then
		//   (b) run /compact themselves when convenient - the result lands in
		//       their target range.
		//
		// pi's own autocompactor also fires near the context-window edge, so a
		// runaway session is never load-bearing on this notification.
		const usage = ctx.getContextUsage();
		if (shouldCompactContext(usage, DEFAULT_MAX_CONTEXT_TOKENS) && ctx.hasUI) {
			ctx.ui.notify(
				`Cron: pi session at ${usage?.tokens}/${usage?.contextWindow} tokens, over your ${DEFAULT_MAX_CONTEXT_TOKENS} cap. Set 'compaction.keepRecentTokens: 80000' in pi settings, then /compact when convenient.`,
				"warning",
			);
		}

		if (ctx.hasUI) ctx.ui.notify(`Cron fired: ${job.description || job.name} [${job.source}]`, "info");
		return true;
	}

	function checkAndFireJobs(): void {
		const ctx = lastCtx;
		if (!ctx) return;
		const now = new Date();
		let dispatchedThisTick = false;
		for (const job of jobs) {
			try {
				if (fireOneJob(job, now, ctx, dispatchedThisTick)) {
					dispatchedThisTick = true;
				}
			} catch (err) {
				// Per-job try/catch so any throw - readFileSync against a special
				// file, sendUserMessage rejection, anything - is contained to this
				// one job and never escapes the setInterval callback.
				const msg = err instanceof Error ? err.message : String(err);
				if (ctx.hasUI) ctx.ui.notify(`Cron "${job.name}": dispatch failed: ${msg}`, "error");
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		cwdDir = ctx.cwd;
		jobs = loadAllJobs(homeDir, cwdDir);

		if (timer) clearInterval(timer);
		timer = setInterval(checkAndFireJobs, CHECK_INTERVAL_MS);
		// We deliberately do NOT call checkAndFireJobs() here. Earlier versions
		// did to "catch up" jobs whose matching minute coincided with session
		// start, but in practice this races with pi's own user-message dispatch
		// (especially in print mode, where the user prompt is in flight at
		// session_start) and produces "Agent is already processing" errors. The
		// first timer tick lands within ≤60s; for a wall-clock scheduler that's
		// fine, and it's uniformly safer than fighting the dispatch race.

		if (ctx.hasUI) {
			const globalCount = jobs.filter((j) => j.source === "global").length;
			const localCount = jobs.filter((j) => j.source === "local").length;
			ctx.ui.notify(
				`Cron extension loaded: ${jobs.length} job(s) (${globalCount} global, ${localCount} local).`,
				"info",
			);
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
		description: "List registered cron jobs (with source, last-fired, history depth)",
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
				lines.push(
					`[${job.source}] ${job.name}  cron: ${job.cronExpression}${desc}  (last: ${when}, ${depth} entries)`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("cron-remove", {
		description: "Remove a cron job in-memory (config file remains on disk)",
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

			const sessionFile = getJobSessionPath(job, stateDir);
			if (existsSync(sessionFile)) {
				try {
					writeFileSync(sessionFile, "");
				} catch {
					/* ignore */
				}
			}
			ctx.ui.notify(`Removed cron job: ${name} [${job.source}] (session file cleared)`, "info");
		},
	});
}
