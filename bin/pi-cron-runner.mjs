#!/usr/bin/env node
/**
 * pi-cron-runner: standalone cron dispatcher for headless deployments.
 *
 * One invocation = one tick. Reads ~/.pi/cron.d/ and <cwd>/.pi/cron.d/,
 * evaluates each job's cron expression against the current minute, and spawns
 * a `pi` subprocess for any due jobs. Each subprocess targets the job's own
 * per-task session file at ~/.pi/cron-sessions/, so each cron task accumulates
 * its own conversation history across runs.
 *
 * This is the headless counterpart to the in-pi cron extension. The extension
 * runs the scheduler inside an interactive pi process. The runner does the
 * same scheduling but is triggered externally (typically by `systemd timer`)
 * so it works on a VM where no human is in pi.
 *
 *   systemd timer fires every minute
 *     ↓
 *   /usr/local/bin/pi-cron-runner
 *     ↓
 *   tick: load .cron files, find due jobs, spawn pi -p subprocesses
 *     ↓
 *   each subprocess loads its session, runs the agent, writes output, exits
 *
 * Usage:
 *   pi-cron-runner            # one tick (the systemd-timer use case)
 *   pi-cron-runner --jobs     # list discovered jobs and exit
 *   pi-cron-runner --version  # version + exit
 *   pi-cron-runner --help     # help text
 *
 * IMPORTANT: helper functions below are inlined from cron.ts. They MUST stay
 * behaviorally identical. parity.test.ts compares both sides for representative
 * inputs and will fail if drift creeps in. If you change one, change both.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

const VERSION = "0.2.0";

// =============================================================================
// Cron parsing (inlined from cron.ts)
// =============================================================================

/** @typedef {{ name: string, promptPath: string, cronExpression: string, description?: string, source: "global"|"local", configFile: string }} CronJob */
/** @typedef {Pick<CronJob, "name" | "configFile">} JobIdentity */

const FIRST_TIME_LOOKBACK_MS = 5 * 60 * 1000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEDUP_WINDOW_MS = 60_000;
const SUBPROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_JOB_HISTORY_LINES = 200;
const COMPACTION_KEEP = 50;

export function parseCronField(field, max) {
	const out = new Set();
	for (const piece of field.split(",")) {
		const seg = piece.trim();
		if (!seg) continue;
		let rangeStr = seg;
		let step = 1;
		const slashIdx = seg.indexOf("/");
		if (slashIdx !== -1) {
			rangeStr = seg.slice(0, slashIdx);
			const stepN = Number.parseInt(seg.slice(slashIdx + 1), 10);
			if (!Number.isFinite(stepN) || stepN <= 0) continue;
			step = stepN;
		}
		let from;
		let to;
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
		const fromClamped = Math.max(0, from);
		const toClamped = Math.min(max - 1, to);
		if (toClamped < fromClamped) continue;
		for (let v = fromClamped; v <= toClamped; v += step) {
			out.add(v);
		}
	}
	return [...out].sort((a, b) => a - b);
}

export function matchesCron(expression, now) {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const minutes = parseCronField(parts[0], 60);
	const hours = parseCronField(parts[1], 24);
	const days = parseCronField(parts[2], 32);
	const months = parseCronField(parts[3], 13);
	const dowRaw = parseCronField(parts[4], 8);
	const dow = [...new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
	if (!minutes.includes(now.getMinutes())) return false;
	if (!hours.includes(now.getHours())) return false;
	if (!months.includes(now.getMonth() + 1)) return false;
	const domMatch = days.includes(now.getDate());
	const dowMatch = dow.includes(now.getDay());
	const domRestricted = parts[2].trim() !== "*";
	const dowRestricted = parts[4].trim() !== "*";
	if (domRestricted && dowRestricted) return domMatch || dowMatch;
	return domMatch && dowMatch;
}

export function floorToMinute(d) {
	const f = new Date(d);
	f.setSeconds(0, 0);
	return f;
}

export function findMostRecentDueMinute(job, now, lastFireMs, runnerStartMs, dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS) {
	const nowMs = now.getTime();
	let lowerBoundMs;
	if (lastFireMs !== null) {
		lowerBoundMs = Math.max(nowMs - MAX_LOOKBACK_MS, lastFireMs + dedupWindowMs);
	} else {
		lowerBoundMs = Math.max(nowMs - FIRST_TIME_LOOKBACK_MS, runnerStartMs);
	}
	if (lowerBoundMs > nowMs) return null;
	let cursor = floorToMinute(now);
	while (cursor.getTime() >= lowerBoundMs) {
		if (matchesCron(job.cronExpression, cursor)) return cursor;
		cursor = new Date(cursor.getTime() - 60_000);
	}
	return null;
}

// =============================================================================
// Slug + hash (inlined from cron.ts)
// =============================================================================

export function safeNameSlug(name) {
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	return sanitized.length > 0 ? sanitized : "_anonymous";
}

export function configHash(configFile) {
	return createHash("sha256").update(configFile).digest("hex").slice(0, 10);
}

// =============================================================================
// Job loading (inlined from cron.ts)
// =============================================================================

export function loadCronFile(filePath, source) {
	if (!existsSync(filePath)) return null;
	let content;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	let name;
	let promptPath;
	let cronExpression;
	let description;
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

function findCronFiles(dir) {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith(".cron"))
			.map((d) => join(dir, d.name));
	} catch {
		return [];
	}
}

export function discoverCronFiles(homeDir, cwdDir) {
	const out = [];
	for (const f of findCronFiles(join(homeDir, ".pi", "cron.d"))) out.push({ path: f, source: "global" });
	for (const f of findCronFiles(join(cwdDir, ".pi", "cron.d"))) out.push({ path: f, source: "local" });
	return out;
}

export function loadAllJobs(homeDir, cwdDir) {
	const out = [];
	for (const { path: p, source } of discoverCronFiles(homeDir, cwdDir)) {
		const job = loadCronFile(p, source);
		if (job) out.push(job);
	}
	return out;
}

// =============================================================================
// State files (inlined from cron.ts)
// =============================================================================

export function getJobSessionPath(job, baseDir) {
	const filename = `${safeNameSlug(job.name)}-${configHash(job.configFile)}.jsonl`;
	const candidate = join(baseDir, filename);
	const rel = relative(baseDir, candidate);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`cron state path escaped baseDir (job.name="${job.name}")`);
	}
	return candidate;
}

export function getTaskSessionPath(job, baseDir) {
	const filename = `${safeNameSlug(job.name)}-${configHash(job.configFile)}.jsonl`;
	const candidate = join(baseDir, filename);
	const rel = relative(baseDir, candidate);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`cron task session path escaped baseDir (job.name="${job.name}")`);
	}
	return candidate;
}

export function loadJobHistory(job, baseDir) {
	const path = getJobSessionPath(job, baseDir);
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

export function appendJobMessage(job, prompt, baseDir) {
	const path = getJobSessionPath(job, baseDir);
	mkdirSync(dirname(path), { recursive: true });
	const entry = { type: "fired", prompt, timestamp: new Date().toISOString() };
	writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

export function compactJobHistory(job, baseDir, maxLines = MAX_JOB_HISTORY_LINES, keepCount = COMPACTION_KEEP) {
	const entries = loadJobHistory(job, baseDir);
	if (entries.length <= maxLines) return entries;
	const recent = entries.slice(-keepCount);
	const old = entries.slice(0, -keepCount);
	const fires = old.filter((e) => e.type === "fired");
	const summary = {
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

export function getLastFireTime(job, baseDir) {
	const entries = loadJobHistory(job, baseDir);
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "fired") return new Date(entries[i].timestamp).getTime();
	}
	return null;
}

// =============================================================================
// Path safety (inlined from cron.ts)
// =============================================================================

export function isReadableRegularFile(p) {
	let stat;
	try {
		stat = statSync(p);
	} catch (err) {
		return { ok: false, reason: `stat failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!stat.isFile()) return { ok: false, reason: "not a regular file" };
	try {
		accessSync(p, fsConstants.R_OK);
	} catch {
		return { ok: false, reason: "not readable" };
	}
	return { ok: true };
}

export function validateLocalPromptPath(promptPath, cwdDir) {
	if (promptPath.startsWith("~")) {
		return { ok: false, error: `project-local cron prompts cannot use ~ paths (got "${promptPath}")` };
	}
	if (isAbsolute(promptPath)) {
		return { ok: false, error: `project-local cron prompts cannot use absolute paths (got "${promptPath}")` };
	}
	let cwdReal;
	try {
		cwdReal = realpathSync(cwdDir);
	} catch {
		return { ok: false, error: `cwd not accessible: ${cwdDir}` };
	}
	const joined = join(cwdDir, promptPath);
	let canonical;
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

export function resolveGlobalPromptPath(promptPath, configFileDir, homeDir) {
	if (promptPath.startsWith("~/")) return join(homeDir, promptPath.slice(2));
	if (isAbsolute(promptPath)) return promptPath;
	return join(configFileDir, promptPath);
}

export function resolveJobPrompt(job, cwdDir, homeDir) {
	let basic;
	if (job.source === "local") {
		basic = validateLocalPromptPath(job.promptPath, cwdDir);
	} else {
		const resolved = resolveGlobalPromptPath(job.promptPath, dirname(job.configFile), homeDir);
		basic = existsSync(resolved) ? { ok: true, resolved } : { ok: false, error: `prompt file not found: ${resolved}` };
	}
	if (!basic.ok) return basic;
	const fileCheck = isReadableRegularFile(basic.resolved);
	if (!fileCheck.ok) return { ok: false, error: `prompt path is ${fileCheck.reason}: ${basic.resolved}` };
	return basic;
}

export function prepareCronDispatch(job, cwdDir, homeDir) {
	const r = resolveJobPrompt(job, cwdDir, homeDir);
	if (!r.ok) return { ok: false, reason: r.error };
	let promptContent;
	try {
		promptContent = readFileSync(r.resolved, "utf-8").trim();
	} catch (err) {
		return { ok: false, reason: `failed to read prompt: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!promptContent) return { ok: false, reason: "prompt file is empty" };
	return { ok: true, resolved: r.resolved, promptContent, tagged: `[cron: ${job.name}]\n${promptContent}` };
}

export function buildSubprocessArgs(taskSessionPath, taggedPrompt) {
	return ["--no-extensions", "-p", "-c", "--session", taskSessionPath, taggedPrompt];
}

// =============================================================================
// Subprocess
// =============================================================================

/**
 * Spawn `pi` with the given args. Returns {code, stdout, stderr}. Sets
 * PI_CRON_SUBPROCESS=1 so the cron extension (if it auto-loads in the spawned
 * pi) recognizes it shouldn't schedule. We also pass --no-extensions in args
 * as belt-and-suspenders.
 */
export function spawnPi(args, cwd, timeoutMs = SUBPROCESS_TIMEOUT_MS) {
	return new Promise((resolve) => {
		const proc = spawn("pi", args, {
			cwd,
			env: { ...process.env, PI_CRON_SUBPROCESS: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let killed = false;
		const timeout = setTimeout(() => {
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 5000);
		}, timeoutMs);
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			clearTimeout(timeout);
			resolve({ stdout, stderr, code: code ?? 0, killed });
		});
		proc.on("error", (err) => {
			clearTimeout(timeout);
			resolve({ stdout: "", stderr: err.message, code: -1, killed });
		});
	});
}

// =============================================================================
// Tick
// =============================================================================

async function tick(opts = {}) {
	const homeDir = opts.homeDir ?? homedir();
	const cwdDir = opts.cwdDir ?? process.cwd();
	const stateDir = opts.stateDir ?? join(homeDir, ".pi", "cron");
	const sessionDir = opts.sessionDir ?? join(homeDir, ".pi", "cron-sessions");
	const log = opts.log ?? ((...args) => console.log(...args));
	const errlog = opts.errlog ?? ((...args) => console.error(...args));
	const spawnFn = opts.spawn ?? ((args, cwd) => spawnPi(args, cwd));

	const startMs = Date.now();
	const jobs = loadAllJobs(homeDir, cwdDir);
	if (jobs.length === 0) {
		log("[pi-cron-runner] no .cron files found in ~/.pi/cron.d/ or .pi/cron.d/");
		return { fired: 0, skipped: 0, failed: 0, total: 0 };
	}

	const allDiscovered = discoverCronFiles(homeDir, cwdDir);
	const loadedSet = new Set(jobs.map((j) => j.configFile));
	const failedToLoad = allDiscovered.filter((d) => !loadedSet.has(d.path));
	if (failedToLoad.length > 0) {
		errlog(`[pi-cron-runner] ${failedToLoad.length} .cron file(s) failed to parse:`);
		for (const f of failedToLoad) errlog(`  - ${f.path}`);
	}

	const now = new Date();
	let fired = 0;
	let skipped = 0;
	let failed = 0;

	for (const job of jobs) {
		try {
			const lastFire = getLastFireTime(job, stateDir);
			const matchedAt = findMostRecentDueMinute(job, now, lastFire, 0);
			if (!matchedAt) {
				skipped++;
				continue;
			}

			const prep = prepareCronDispatch(job, cwdDir, homeDir);
			if (!prep.ok) {
				errlog(`[pi-cron-runner] ${job.name} [${job.source}]: ${prep.reason}`);
				failed++;
				continue;
			}

			const taskSession = getTaskSessionPath(job, sessionDir);
			mkdirSync(dirname(taskSession), { recursive: true });

			const args = buildSubprocessArgs(taskSession, prep.tagged);
			log(`[pi-cron-runner] firing ${job.name} [${job.source}] for ${matchedAt.toISOString()}`);

			const result = await spawnFn(args, cwdDir);
			if (result.killed) {
				errlog(`[pi-cron-runner] ${job.name}: subprocess killed (timeout)`);
				failed++;
				continue;
			}
			if (result.code !== 0) {
				const stderrSnip = (result.stderr || "(empty)").slice(0, 500).trim();
				errlog(`[pi-cron-runner] ${job.name}: pi exited ${result.code}. stderr: ${stderrSnip}`);
				failed++;
				continue;
			}

			try {
				compactJobHistory(job, stateDir);
				appendJobMessage(job, prep.promptContent, stateDir);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				errlog(`[pi-cron-runner] ${job.name}: state persist failed: ${msg}`);
			}
			fired++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errlog(`[pi-cron-runner] ${job.name}: dispatch error: ${msg}`);
			failed++;
		}
	}

	const elapsed = Date.now() - startMs;
	log(
		`[pi-cron-runner] tick complete: ${fired} fired, ${skipped} not due, ${failed} failed (${elapsed}ms, ${jobs.length} total jobs)`,
	);
	return { fired, skipped, failed, total: jobs.length };
}

async function listJobsCmd() {
	const homeDir = homedir();
	const cwdDir = process.cwd();
	const stateDir = join(homeDir, ".pi", "cron");
	const sessionDir = join(homeDir, ".pi", "cron-sessions");
	const jobs = loadAllJobs(homeDir, cwdDir);
	if (jobs.length === 0) {
		console.log("No .cron files found.");
		console.log(`  Looked in: ${join(homeDir, ".pi", "cron.d")}`);
		console.log(`  Looked in: ${join(cwdDir, ".pi", "cron.d")}`);
		return;
	}
	for (const job of jobs) {
		const last = getLastFireTime(job, stateDir);
		const when = last ? new Date(last).toISOString() : "never";
		const taskSession = getTaskSessionPath(job, sessionDir);
		const sessionExists = existsSync(taskSession) ? "✓" : "✗";
		const desc = job.description ? ` - ${job.description}` : "";
		console.log(
			`[${job.source}] ${job.name}  cron: ${job.cronExpression}${desc}  (last: ${when}, session: ${sessionExists})`,
		);
	}
}

function helpText() {
	return `pi-cron-runner v${VERSION}

Standalone cron dispatcher for headless deployments. One invocation = one tick.

Usage:
  pi-cron-runner            One tick: scan jobs, fire any due, exit
  pi-cron-runner --jobs     List discovered jobs and exit
  pi-cron-runner --version  Print version and exit
  pi-cron-runner --help     Show this help

Discovery paths:
  ~/.pi/cron.d/*.cron       global jobs (trusted)
  ./.pi/cron.d/*.cron       project-local jobs (sandboxed - see README)

Per-task session files:
  ~/.pi/cron-sessions/<slug>-<hash>.jsonl

Fire-log metadata:
  ~/.pi/cron/<slug>-<hash>.jsonl

Typical systemd setup (see examples/systemd/):
  sudo cp examples/systemd/pi-cron-runner.{service,timer} /etc/systemd/system/
  sudo systemctl enable --now pi-cron-runner.timer
`;
}

// Only auto-run when invoked as a script (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	const args = process.argv.slice(2);
	let exitCode = 0;
	try {
		if (args.includes("--version")) {
			console.log(`pi-cron-runner ${VERSION}`);
		} else if (args.includes("--help") || args.includes("-h")) {
			console.log(helpText());
		} else if (args.includes("--jobs")) {
			await listJobsCmd();
		} else {
			const result = await tick();
			if (result.failed > 0) exitCode = 2;
		}
	} catch (err) {
		console.error("[pi-cron-runner] fatal:", err instanceof Error ? err.message : String(err));
		exitCode = 1;
	}
	process.exit(exitCode);
}

export { tick, listJobsCmd };
