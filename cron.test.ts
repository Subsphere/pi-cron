/**
 * Tests for cron.ts. Standalone version of the in-tree test suite.
 *
 * Layered:
 *  - pure-function units (parser, dedup, persistence, compaction, path safety)
 *  - end-to-end firing simulation that doesn't wait for setInterval ticks
 *  - end-to-end SECURITY simulation (malicious local .cron blocked)
 *
 * Integration tests against pi's runner live in pi-mono - they need pi
 * internals that aren't published from @mariozechner/pi-coding-agent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import {
	appendJobMessage,
	type CronJob,
	compactJobHistory,
	configHash,
	discoverCronFiles,
	FIRST_TIME_LOOKBACK_MS,
	findMostRecentDueMinute,
	floorToMinute,
	getJobEntryCount,
	getJobSessionPath,
	getLastFireTime,
	isReadableRegularFile,
	type JobEntry,
	type JobIdentity,
	loadAllJobs,
	loadCronFile,
	loadJobHistory,
	MAX_LOOKBACK_MS,
	matchesCron,
	parseCronField,
	prepareCronDispatch,
	resolveGlobalPromptPath,
	resolveJobPrompt,
	safeNameSlug,
	shouldCompactContext,
	shouldFire,
	validateLocalPromptPath,
} from "./cron.js";

/** Build a minimal JobIdentity for state-path tests. */
function id(name: string, configFile: string): JobIdentity {
	return { name, configFile };
}

/** Build a full CronJob fixture for shouldFire / dispatch tests. */
function makeJob(overrides: Partial<CronJob> = {}): CronJob {
	return {
		name: "fixture",
		promptPath: "p.md",
		cronExpression: "* * * * *",
		source: "global",
		configFile: "/tmp/fixture.cron",
		...overrides,
	};
}

// =============================================================================
// parseCronField
// =============================================================================

describe("parseCronField", () => {
	it("expands * across full range exclusive of max", () => {
		expect(parseCronField("*", 60)).toHaveLength(60);
		expect(parseCronField("*", 60)[0]).toBe(0);
		expect(parseCronField("*", 60).at(-1)).toBe(59);
		expect(parseCronField("*", 24)).toHaveLength(24);
	});

	it("handles plain integers", () => {
		expect(parseCronField("0", 60)).toEqual([0]);
		expect(parseCronField("17", 60)).toEqual([17]);
	});

	it("handles step on top of star", () => {
		expect(parseCronField("*/15", 60)).toEqual([0, 15, 30, 45]);
		expect(parseCronField("*/30", 60)).toEqual([0, 30]);
	});

	it("handles ranges", () => {
		expect(parseCronField("3-7", 60)).toEqual([3, 4, 5, 6, 7]);
	});

	it("handles stepped ranges (the regression fix)", () => {
		// Original parser short-circuited on "/" before "-", returning garbage
		// for "1-10/2". We now must produce odd values from 1..9.
		expect(parseCronField("1-10/2", 60)).toEqual([1, 3, 5, 7, 9]);
		expect(parseCronField("0-30/10", 60)).toEqual([0, 10, 20, 30]);
	});

	it("handles comma lists", () => {
		expect(parseCronField("0,15,45", 60)).toEqual([0, 15, 45]);
	});

	it("combines comma + range + step", () => {
		expect(parseCronField("0,30,45-50/2", 60)).toEqual([0, 30, 45, 47, 49]);
	});

	it("clips out-of-range values", () => {
		expect(parseCronField("70", 60)).toEqual([]);
	});

	it("returns [] for unparseable input", () => {
		expect(parseCronField("nope", 60)).toEqual([]);
		expect(parseCronField("", 60)).toEqual([]);
	});

	it("rejects bogus step values", () => {
		expect(parseCronField("*/0", 60)).toEqual([]);
		expect(parseCronField("*/abc", 60)).toEqual([]);
	});

	it("CPU SAFETY: clamps gigantic ranges so 0-1000000000/1 doesn't pin the CPU", () => {
		// Without clamping, this would loop one billion times before filtering.
		// With clamping, it iterates at most `max` times. We assert both the
		// correct output AND a generous wall-clock bound to catch regressions.
		const t0 = Date.now();
		const out = parseCronField("0-1000000000/1", 60);
		const elapsed = Date.now() - t0;
		expect(out).toEqual(Array.from({ length: 60 }, (_, i) => i));
		expect(elapsed).toBeLessThan(50);
	});

	it("clamps `to` above max down to max-1", () => {
		// `55-99` parses to from=55, to=99; should clamp to [55, 59] for minutes.
		expect(parseCronField("55-99", 60)).toEqual([55, 56, 57, 58, 59]);
	});
});

// =============================================================================
// matchesCron
// =============================================================================

describe("matchesCron", () => {
	it("rejects expressions that aren't 5 fields", () => {
		const now = new Date(2026, 3, 26, 12, 0);
		expect(matchesCron("* * * *", now)).toBe(false);
		expect(matchesCron("* * * * * *", now)).toBe(false);
	});

	it("matches every-minute wildcard", () => {
		const now = new Date(2026, 3, 26, 12, 0);
		expect(matchesCron("* * * * *", now)).toBe(true);
	});

	it("matches noon-only schedule at noon", () => {
		const noon = new Date(2026, 3, 26, 12, 0);
		const elevenFiftyNine = new Date(2026, 3, 26, 11, 59);
		expect(matchesCron("0 12 * * *", noon)).toBe(true);
		expect(matchesCron("0 12 * * *", elevenFiftyNine)).toBe(false);
	});

	it("matches 30-minute interval at minute 0 and 30 only", () => {
		const at0 = new Date(2026, 3, 26, 12, 0);
		const at15 = new Date(2026, 3, 26, 12, 15);
		const at30 = new Date(2026, 3, 26, 12, 30);
		expect(matchesCron("0,30 * * * *", at0)).toBe(true);
		expect(matchesCron("0,30 * * * *", at15)).toBe(false);
		expect(matchesCron("0,30 * * * *", at30)).toBe(true);
	});

	it("DOW: 7 is normalized to 0 (Sunday) per standard cron (codex round-4 #3)", () => {
		// Sunday is getDay() === 0. Both `0` and `7` should match.
		const sun = new Date(2026, 3, 26, 12, 0); // Apr 26 2026 = Sunday
		expect(sun.getDay()).toBe(0);
		expect(matchesCron("0 12 * * 0", sun)).toBe(true);
		expect(matchesCron("0 12 * * 7", sun)).toBe(true);
	});

	it("POSIX cron: when BOTH DOM and DOW are restricted, semantics is OR (codex round-4 #3)", () => {
		// `0 0 1 * 1` = midnight on the 1st OR every Monday. Apr 26 2026 is
		// Sunday the 26th - matches NEITHER, so should not fire.
		const sun26 = new Date(2026, 3, 26, 0, 0);
		expect(matchesCron("0 0 1 * 1", sun26)).toBe(false);

		// Apr 27 2026 is Monday the 27th - matches DOW=1 (Monday), should fire.
		const mon27 = new Date(2026, 3, 27, 0, 0);
		expect(mon27.getDay()).toBe(1);
		expect(matchesCron("0 0 1 * 1", mon27)).toBe(true);

		// Apr 1 2026 is Wednesday the 1st - matches DOM=1, should fire (OR).
		const wed1 = new Date(2026, 3, 1, 0, 0);
		expect(wed1.getDate()).toBe(1);
		expect(matchesCron("0 0 1 * 1", wed1)).toBe(true);
	});

	it("when only DOW is restricted, AND semantics (the * for DOM admits everything)", () => {
		// `0 0 * * 1` = midnight every Monday. Apr 27 2026 (Mon) → match;
		// Apr 26 2026 (Sun) → no match.
		const mon = new Date(2026, 3, 27, 0, 0);
		const sun = new Date(2026, 3, 26, 0, 0);
		expect(matchesCron("0 0 * * 1", mon)).toBe(true);
		expect(matchesCron("0 0 * * 1", sun)).toBe(false);
	});

	it("when only DOM is restricted, AND semantics (the * for DOW admits everything)", () => {
		const first = new Date(2026, 3, 1, 0, 0);
		const second = new Date(2026, 3, 2, 0, 0);
		expect(matchesCron("0 0 1 * *", first)).toBe(true);
		expect(matchesCron("0 0 1 * *", second)).toBe(false);
	});
});

// =============================================================================
// loadCronFile + discovery + source tagging
// =============================================================================

describe("loadCronFile", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cron-load-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("parses a well-formed cron file with all fields", () => {
		const file = path.join(tmp, "job.cron");
		fs.writeFileSync(
			file,
			[
				"# leading comment is ignored",
				"name: test-job",
				"prompt: prompts/test.md",
				"cron: */15 * * * *",
				"description: A test job",
				"",
			].join("\n"),
		);
		const job = loadCronFile(file, "global");
		expect(job).not.toBeNull();
		expect(job?.name).toBe("test-job");
		expect(job?.promptPath).toBe("prompts/test.md");
		expect(job?.cronExpression).toBe("*/15 * * * *");
		expect(job?.description).toBe("A test job");
		expect(job?.source).toBe("global");
		expect(job?.configFile).toBe(file);
	});

	it("stamps source=local when loaded as local", () => {
		const file = path.join(tmp, "local.cron");
		fs.writeFileSync(file, "name: local\nprompt: p.md\ncron: * * * * *\n");
		const job = loadCronFile(file, "local");
		expect(job?.source).toBe("local");
		expect(job?.configFile).toBe(file);
	});

	it("returns null when required fields are missing", () => {
		const file = path.join(tmp, "incomplete.cron");
		fs.writeFileSync(file, "name: only-name\n");
		expect(loadCronFile(file, "global")).toBeNull();
	});

	it("returns null on missing file", () => {
		expect(loadCronFile(path.join(tmp, "ghost.cron"), "global")).toBeNull();
	});

	it("returns null (does NOT throw) when path is a directory (codex round-6)", () => {
		const dirPath = path.join(tmp, "fakejob.cron");
		fs.mkdirSync(dirPath);
		expect(() => loadCronFile(dirPath, "global")).not.toThrow();
		expect(loadCronFile(dirPath, "global")).toBeNull();
	});

	it("returns null (does NOT throw) when file is unreadable (codex round-6)", () => {
		const file = path.join(tmp, "noperm.cron");
		fs.writeFileSync(file, "name: x\nprompt: p.md\ncron: * * * * *\n");
		fs.chmodSync(file, 0o000);
		try {
			// Skip this assertion when running as root (root can read any file
			// regardless of mode bits, and the test container is rooted).
			let canRead = true;
			try {
				fs.readFileSync(file, "utf-8");
			} catch {
				canRead = false;
			}
			if (canRead) return; // root context: EACCES not enforced
			expect(() => loadCronFile(file, "global")).not.toThrow();
			expect(loadCronFile(file, "global")).toBeNull();
		} finally {
			fs.chmodSync(file, 0o644);
		}
	});
});

describe("discoverCronFiles + loadAllJobs", () => {
	let home: string;
	let cwd: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "cron-home-"));
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cron-cwd-"));
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	function writeJob(dir: string, basename: string, name: string): string {
		const cronD = path.join(dir, ".pi", "cron.d");
		fs.mkdirSync(cronD, { recursive: true });
		const file = path.join(cronD, basename);
		fs.writeFileSync(file, `name: ${name}\nprompt: p.md\ncron: * * * * *\n`);
		return file;
	}

	it("finds cron files in BOTH ~/.pi/cron.d and <cwd>/.pi/cron.d, tagged by source", () => {
		const a = writeJob(home, "global.cron", "global-job");
		const b = writeJob(cwd, "local.cron", "local-job");
		const files = discoverCronFiles(home, cwd);
		expect(files).toEqual(
			expect.arrayContaining([
				{ path: a, source: "global" },
				{ path: b, source: "local" },
			]),
		);

		const jobs = loadAllJobs(home, cwd);
		const byName = Object.fromEntries(jobs.map((j) => [j.name, j]));
		expect(byName["global-job"].source).toBe("global");
		expect(byName["local-job"].source).toBe("local");
		expect(byName["global-job"].configFile).toBe(a);
		expect(byName["local-job"].configFile).toBe(b);
	});

	it("returns empty list when neither dir exists", () => {
		expect(discoverCronFiles(home, cwd)).toEqual([]);
		expect(loadAllJobs(home, cwd)).toEqual([]);
	});

	it("discoverCronFiles skips directories that happen to end in .cron (codex round-6)", () => {
		const cronD = path.join(home, ".pi", "cron.d");
		fs.mkdirSync(cronD, { recursive: true });
		// A real job
		writeJob(home, "real.cron", "real");
		// A directory named like a cron file - must be skipped, not crash later
		fs.mkdirSync(path.join(cronD, "trap.cron"));

		const files = discoverCronFiles(home, cwd);
		expect(files.map((f) => path.basename(f.path)).sort()).toEqual(["real.cron"]);
	});

	it("loadAllJobs continues past one bad entry (codex round-6 finding)", () => {
		writeJob(home, "good.cron", "good");
		// Plant a malformed file that will be discovered but fail to parse
		// (missing required fields).
		const cronD = path.join(home, ".pi", "cron.d");
		fs.writeFileSync(path.join(cronD, "bad.cron"), "this is not a valid cron file at all\n");

		const jobs = loadAllJobs(home, cwd);
		expect(jobs.map((j) => j.name)).toEqual(["good"]);
	});

	it("loadAllJobs survives a directory entry inside cron.d (regression)", () => {
		writeJob(home, "good.cron", "good");
		const cronD = path.join(home, ".pi", "cron.d");
		fs.mkdirSync(path.join(cronD, "trap.cron"));

		const jobs = loadAllJobs(home, cwd);
		expect(jobs).toHaveLength(1);
		expect(jobs[0].name).toBe("good");
	});
});

// =============================================================================
// configHash + state-path collision isolation (codex finding #3)
// =============================================================================

// =============================================================================
// safeNameSlug + state-path containment (codex round-3 finding #1)
// A repo-controlled `name: ../../escape` MUST NOT let the state file write
// outside the cron state directory.
// =============================================================================

describe("safeNameSlug", () => {
	it("preserves alnum, dash, underscore", () => {
		expect(safeNameSlug("my-job_v2")).toBe("my-job_v2");
	});

	it("replaces traversal characters with underscore", () => {
		expect(safeNameSlug("../../etc/passwd")).toBe("______etc_passwd");
		expect(safeNameSlug("a/b\\c")).toBe("a_b_c");
	});

	it("strips dots so . and .. cannot survive", () => {
		expect(safeNameSlug("..")).toBe("__");
		expect(safeNameSlug(".hidden")).toBe("_hidden");
	});

	it("returns _anonymous on empty input", () => {
		expect(safeNameSlug("")).toBe("_anonymous");
	});

	it("truncates absurdly long names", () => {
		const long = "a".repeat(500);
		expect(safeNameSlug(long).length).toBe(64);
	});
});

describe("getJobSessionPath — containment guarantee", () => {
	it("a malicious name CANNOT escape the state dir", () => {
		const baseDir = "/state";
		const malicious = id("../../etc/passwd", "/c.cron");
		const p = getJobSessionPath(malicious, baseDir);
		// Must still be inside baseDir; the dirname must equal baseDir.
		expect(path.dirname(p)).toBe(baseDir);
		// And the basename must NOT contain a slash or dotdot.
		expect(path.basename(p)).not.toMatch(/\.\./);
		expect(path.basename(p)).not.toContain("/");
	});

	it("two different malicious names with the same configFile still get different paths", () => {
		const a = getJobSessionPath(id("../../a", "/c.cron"), "/state");
		const b = getJobSessionPath(id("../../b", "/c.cron"), "/state");
		expect(a).not.toBe(b);
	});
});

describe("configHash + state-file isolation", () => {
	it("produces a stable 10-char hex digest for a given path", () => {
		const h = configHash("/some/abs/path.cron");
		expect(h).toMatch(/^[0-9a-f]{10}$/);
		expect(configHash("/some/abs/path.cron")).toBe(h);
	});

	it("produces different hashes for different paths", () => {
		expect(configHash("/a.cron")).not.toBe(configHash("/b.cron"));
	});

	it("two jobs with same name but different configFile get different state paths", () => {
		const globalJob = id("ping", "/home/u/.pi/cron.d/ping.cron");
		const localJob = id("ping", "/repo/.pi/cron.d/ping.cron");
		const a = getJobSessionPath(globalJob, "/state");
		const b = getJobSessionPath(localJob, "/state");
		expect(a).not.toBe(b);
		expect(a).toMatch(/ping-[0-9a-f]{10}\.jsonl$/);
		expect(b).toMatch(/ping-[0-9a-f]{10}\.jsonl$/);
	});

	it("dedup window of one job does NOT suppress the other (the codex finding)", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-isolate-"));
		try {
			const globalJob = id("ping", "/global/ping.cron");
			const localJob = id("ping", "/local/ping.cron");

			appendJobMessage(globalJob, "from global", stateDir);
			expect(getLastFireTime(globalJob, stateDir)).not.toBeNull();
			// Local job's lastFireTime must be unaffected by global's append.
			expect(getLastFireTime(localJob, stateDir)).toBeNull();

			appendJobMessage(localJob, "from local", stateDir);
			expect(getJobEntryCount(globalJob, stateDir)).toBe(1);
			expect(getJobEntryCount(localJob, stateDir)).toBe(1);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});
});

// =============================================================================
// History persistence + compaction (using new JobIdentity-based API)
// =============================================================================

describe("history persistence", () => {
	let stateDir: string;
	const j = id("alpha", "/some/path/alpha.cron");
	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-state-"));
	});
	afterEach(() => {
		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("creates the state dir on first append", () => {
		const nested = path.join(stateDir, "nested-not-yet-created");
		appendJobMessage(j, "first prompt", nested);
		expect(fs.existsSync(getJobSessionPath(j, nested))).toBe(true);
		const history = loadJobHistory(j, nested);
		expect(history).toHaveLength(1);
		expect(history[0].type).toBe("fired");
		expect(history[0].prompt).toBe("first prompt");
	});

	it("appends preserve order", () => {
		const beta = id("beta", "/p/beta.cron");
		appendJobMessage(beta, "one", stateDir);
		appendJobMessage(beta, "two", stateDir);
		appendJobMessage(beta, "three", stateDir);
		expect(loadJobHistory(beta, stateDir).map((e) => e.prompt)).toEqual(["one", "two", "three"]);
		expect(getJobEntryCount(beta, stateDir)).toBe(3);
	});

	it("getLastFireTime returns the most recent fired timestamp", () => {
		const gamma = id("gamma", "/p/gamma.cron");
		const before = Date.now();
		appendJobMessage(gamma, "p", stateDir);
		const ts = getLastFireTime(gamma, stateDir);
		expect(ts).not.toBeNull();
		expect(ts! >= before).toBe(true);
		expect(ts! <= Date.now()).toBe(true);
	});
});

describe("compactJobHistory", () => {
	let stateDir: string;
	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-compact-"));
	});
	afterEach(() => {
		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("is a no-op below the threshold", () => {
		const delta = id("delta", "/p/delta.cron");
		for (let i = 0; i < 5; i++) appendJobMessage(delta, `p${i}`, stateDir);
		const out = compactJobHistory(delta, stateDir, 10, 3);
		expect(out).toHaveLength(5);
		expect(out.every((e) => e.type === "fired")).toBe(true);
	});

	it("compacts above threshold to summary + tail", () => {
		const eps = id("epsilon", "/p/epsilon.cron");
		for (let i = 0; i < 12; i++) appendJobMessage(eps, `p${i}`, stateDir);
		const out = compactJobHistory(eps, stateDir, 10, 3);
		expect(out).toHaveLength(4); // 1 summary + 3 recent
		expect(out[0].type).toBe("compaction_summary");
		expect(out[0].summary).toContain("COMPACTED 9 entries");
		expect(out.slice(1).map((e) => e.prompt)).toEqual(["p9", "p10", "p11"]);
		expect(loadJobHistory(eps, stateDir)).toEqual(out);
	});
});

// =============================================================================
// floorToMinute + findMostRecentDueMinute — catch-up scheduler
// (codex round-6 finding: missed minute boundaries on sleep/wake/late-start)
// =============================================================================

describe("floorToMinute", () => {
	it("strips seconds and milliseconds", () => {
		const d = new Date(2026, 3, 27, 14, 30, 45, 123);
		const f = floorToMinute(d);
		expect(f.getSeconds()).toBe(0);
		expect(f.getMilliseconds()).toBe(0);
		expect(f.getMinutes()).toBe(30);
		expect(f.getHours()).toBe(14);
	});

	it("does not mutate input", () => {
		const d = new Date(2026, 3, 27, 14, 30, 45);
		const original = d.getTime();
		floorToMinute(d);
		expect(d.getTime()).toBe(original);
	});
});

describe("findMostRecentDueMinute", () => {
	const everyMinute = makeJob({ name: "every", cronExpression: "* * * * *" });
	const noonOnly = makeJob({ name: "noon", cronExpression: "0 12 * * *" });
	const hourly = makeJob({ name: "hourly", cronExpression: "0 * * * *" });
	const february30 = makeJob({ name: "never", cronExpression: "0 0 30 2 *" });

	const at = (h: number, m: number, s = 0) => new Date(2026, 3, 27, h, m, s);

	it("never-fired job: returns now when current minute matches", () => {
		const now = at(12, 0, 30);
		const loadMs = at(12, 0, 0).getTime();
		const r = findMostRecentDueMinute(noonOnly, now, null, loadMs);
		expect(r).not.toBeNull();
		expect(r?.getHours()).toBe(12);
		expect(r?.getMinutes()).toBe(0);
	});

	it("never-fired job: catches a 3-minute-old matching minute (within 5min lookback)", () => {
		const now = at(12, 3, 0);
		const loadMs = at(12, 0, 0).getTime();
		const r = findMostRecentDueMinute(noonOnly, now, null, loadMs);
		expect(r).not.toBeNull();
		expect(r?.getHours()).toBe(12);
		expect(r?.getMinutes()).toBe(0);
	});

	it("never-fired job: returns null for a 30-minute-old match (outside 5min lookback)", () => {
		const now = at(12, 30, 0);
		const loadMs = at(12, 0, 0).getTime();
		const r = findMostRecentDueMinute(noonOnly, now, null, loadMs);
		expect(r).toBeNull();
	});

	it("never-fired job: respects the extensionLoadMs floor (no firing pre-load schedules)", () => {
		// Match was at 11:55, but extension only loaded at 11:58, so the
		// matching minute is BEFORE the extension was running. Don't fire.
		const before = makeJob({ name: "before", cronExpression: "55 11 * * *" });
		const now = at(11, 59, 0);
		const loadMs = at(11, 58, 0).getTime();
		const r = findMostRecentDueMinute(before, now, null, loadMs);
		expect(r).toBeNull();
	});

	it("previously-fired job: catches up to 24h old matches", () => {
		const now = at(12, 30, 0);
		// Last fire was a long time ago - 25 hours. The 12:00 match today is
		// within the 24h lookback window, so we expect a catch-up fire.
		const lastFire = now.getTime() - 25 * 60 * 60 * 1000;
		const loadMs = lastFire; // doesn't matter for previously-fired path
		const r = findMostRecentDueMinute(noonOnly, now, lastFire, loadMs);
		expect(r).not.toBeNull();
		expect(r?.getHours()).toBe(12);
		expect(r?.getMinutes()).toBe(0);
	});

	it("previously-fired job: respects the dedup window after a recent fire", () => {
		const now = at(12, 0, 30);
		// Fired 30 seconds ago - within the 60s dedup window, should NOT re-fire.
		const lastFire = now.getTime() - 30_000;
		const r = findMostRecentDueMinute(everyMinute, now, lastFire, 0);
		expect(r).toBeNull();
	});

	it("previously-fired job: fires again once dedup window elapses", () => {
		const now = at(12, 1, 30);
		const lastFire = at(12, 0, 0).getTime(); // 90s ago
		const r = findMostRecentDueMinute(everyMinute, now, lastFire, 0);
		expect(r).not.toBeNull();
	});

	it("never-matching expression returns null even with infinite lookback", () => {
		const now = at(12, 0);
		const r = findMostRecentDueMinute(february30, now, null, 0);
		expect(r).toBeNull();
	});

	it("hourly cron after a 90-minute sleep: returns most recent hourly slot", () => {
		// Sleep started after firing at 11:00. Wake at 12:30. Should fire 12:00.
		const lastFire = at(11, 0, 0).getTime();
		const now = at(12, 30, 0);
		const r = findMostRecentDueMinute(hourly, now, lastFire, lastFire);
		expect(r).not.toBeNull();
		expect(r?.getHours()).toBe(12);
		expect(r?.getMinutes()).toBe(0);
	});

	it("frequent cron after a long sleep: fires once at most-recent matching minute, not N times", () => {
		// `* * * * *` sleeping for 30 min should NOT fire 30 times - it should
		// return ONE matching minute. Caller fires once.
		const lastFire = at(12, 0, 0).getTime();
		const now = at(12, 30, 0);
		const r = findMostRecentDueMinute(everyMinute, now, lastFire, lastFire);
		expect(r).not.toBeNull();
		// Most recent matching minute is 12:30 itself
		expect(r?.getHours()).toBe(12);
		expect(r?.getMinutes()).toBe(30);
	});

	it("performance: walking 24h of minutes for a never-matching cron is fast", () => {
		const now = at(12, 0);
		const lastFire = now.getTime() - MAX_LOOKBACK_MS;
		const t0 = Date.now();
		const r = findMostRecentDueMinute(february30, now, lastFire, lastFire);
		const elapsed = Date.now() - t0;
		expect(r).toBeNull();
		// 1440 matchesCron calls. Should complete in well under a second.
		expect(elapsed).toBeLessThan(500);
	});

	it("constants are sane", () => {
		expect(FIRST_TIME_LOOKBACK_MS).toBe(5 * 60 * 1000);
		expect(MAX_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
	});
});

// =============================================================================
// shouldCompactContext — context-budget cap (small-local-model use case)
// =============================================================================

describe("shouldCompactContext", () => {
	const usage = (tokens: number | null): ContextUsage => ({
		tokens,
		contextWindow: 262_144,
		percent: tokens == null ? null : (tokens / 262_144) * 100,
	});

	it("returns false when usage is undefined (no signal)", () => {
		expect(shouldCompactContext(undefined, 100_000)).toBe(false);
	});

	it("returns false when tokens is null (just-compacted, pi hasn't recounted)", () => {
		expect(shouldCompactContext(usage(null), 100_000)).toBe(false);
	});

	it("returns false when usage is below cap", () => {
		expect(shouldCompactContext(usage(50_000), 100_000)).toBe(false);
		expect(shouldCompactContext(usage(99_999), 100_000)).toBe(false);
	});

	it("returns true when usage exceeds cap", () => {
		expect(shouldCompactContext(usage(100_001), 100_000)).toBe(true);
		expect(shouldCompactContext(usage(250_000), 100_000)).toBe(true);
	});

	it("returns false when cap is disabled (0 or negative)", () => {
		expect(shouldCompactContext(usage(250_000), 0)).toBe(false);
		expect(shouldCompactContext(usage(250_000), -1)).toBe(false);
	});

	it("respects the user's chosen cap (100K vs 50K)", () => {
		expect(shouldCompactContext(usage(75_000), 100_000)).toBe(false);
		expect(shouldCompactContext(usage(75_000), 50_000)).toBe(true);
	});
});

// =============================================================================
// shouldFire — dedup window + matchesCron composition
// =============================================================================

describe("shouldFire", () => {
	const job = makeJob({ name: "every-minute", cronExpression: "* * * * *" });
	const noMatchJob = makeJob({ name: "noon-only", cronExpression: "0 12 * * *" });

	it("fires when cron matches and there's no prior run", () => {
		expect(shouldFire(job, new Date(2026, 3, 26, 14, 30), null)).toBe(true);
	});

	it("does not fire when cron expression doesn't match the moment", () => {
		expect(shouldFire(noMatchJob, new Date(2026, 3, 26, 14, 30), null)).toBe(false);
	});

	it("suppresses re-fire within 60s default dedup window", () => {
		const now = new Date(2026, 3, 26, 14, 30, 30);
		const lastFireMs = now.getTime() - 30_000;
		expect(shouldFire(job, now, lastFireMs)).toBe(false);
	});

	it("fires again after the dedup window elapses", () => {
		const now = new Date(2026, 3, 26, 14, 30, 30);
		const lastFireMs = now.getTime() - 90_000;
		expect(shouldFire(job, now, lastFireMs)).toBe(true);
	});

	it("regression: was previously gated on 59 minutes — must now allow 30-min schedules", () => {
		const job30 = makeJob({ name: "every30", cronExpression: "0,30 * * * *" });
		const at12_00 = new Date(2026, 3, 26, 12, 0);
		const at12_30 = new Date(2026, 3, 26, 12, 30);
		expect(shouldFire(job30, at12_00, null)).toBe(true);
		expect(shouldFire(job30, at12_30, at12_00.getTime())).toBe(true);
	});
});

// =============================================================================
// Path-safety: validateLocalPromptPath (codex finding #1, CRITICAL)
//
// These tests are the security model. Every rejection here is a vulnerability
// avoided. If any of these regress, a malicious repo can exfiltrate the
// user's home dir to the LLM provider.
// =============================================================================

describe("validateLocalPromptPath — security model", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-safe-")));
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("REJECTS paths starting with ~/", () => {
		const r = validateLocalPromptPath("~/.ssh/id_rsa", cwd);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/cannot use ~/);
	});

	it("REJECTS paths starting with bare ~", () => {
		const r = validateLocalPromptPath("~user/secret", cwd);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/cannot use ~/);
	});

	it("REJECTS absolute paths", () => {
		const r = validateLocalPromptPath("/etc/passwd", cwd);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/absolute/);
	});

	it("REJECTS ../ traversal that escapes the repo", () => {
		// Need a real outside file to make the traversal materialize through realpath
		const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-outside-")));
		const outsideFile = path.join(outsideDir, "secret.txt");
		fs.writeFileSync(outsideFile, "secret");
		try {
			// path.relative(cwd, outsideFile) yields a "../..." style path
			const traversal = path.relative(cwd, outsideFile);
			const r = validateLocalPromptPath(traversal, cwd);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/outside the repo/);
		} finally {
			fs.rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("REJECTS symlinks pointing outside the repo (the realpath defense)", () => {
		const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-outside-")));
		const outsideFile = path.join(outsideDir, "target.txt");
		fs.writeFileSync(outsideFile, "stolen secret");
		const linkPath = path.join(cwd, "innocent.md");
		fs.symlinkSync(outsideFile, linkPath);
		try {
			const r = validateLocalPromptPath("innocent.md", cwd);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/outside the repo/);
		} finally {
			fs.rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("REJECTS prompts pointing to nonexistent files", () => {
		const r = validateLocalPromptPath("nonexistent.md", cwd);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/not found/);
	});

	it("ACCEPTS repo-relative path to a real file", () => {
		const file = path.join(cwd, "prompt.md");
		fs.writeFileSync(file, "hi");
		const r = validateLocalPromptPath("prompt.md", cwd);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.resolved).toBe(file);
	});

	it("ACCEPTS prompts in subdirectories", () => {
		fs.mkdirSync(path.join(cwd, "sub"));
		const file = path.join(cwd, "sub", "x.md");
		fs.writeFileSync(file, "hi");
		const r = validateLocalPromptPath("sub/x.md", cwd);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.resolved).toBe(file);
	});

	it("ACCEPTS symlinks that resolve back inside the repo", () => {
		const target = path.join(cwd, "real.md");
		const linkPath = path.join(cwd, "alias.md");
		fs.writeFileSync(target, "ok");
		fs.symlinkSync(target, linkPath);
		const r = validateLocalPromptPath("alias.md", cwd);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.resolved).toBe(target);
	});

	it("ACCEPTS ./prefix (normalizes correctly)", () => {
		const file = path.join(cwd, "p.md");
		fs.writeFileSync(file, "hi");
		const r = validateLocalPromptPath("./p.md", cwd);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.resolved).toBe(file);
	});

	it("ACCEPTS internal foo/../bar normalization within the repo", () => {
		const file = path.join(cwd, "bar.md");
		fs.writeFileSync(file, "hi");
		fs.mkdirSync(path.join(cwd, "foo"));
		const r = validateLocalPromptPath("foo/../bar.md", cwd);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.resolved).toBe(file);
	});
});

// =============================================================================
// resolveGlobalPromptPath — trusted, liberal
// =============================================================================

describe("resolveGlobalPromptPath", () => {
	it("returns absolute paths unchanged", () => {
		expect(resolveGlobalPromptPath("/etc/foo.md", "/cfg", "/home")).toBe("/etc/foo.md");
	});
	it("expands ~/ to homeDir", () => {
		expect(resolveGlobalPromptPath("~/prompts/x.md", "/cfg", "/home/user")).toBe("/home/user/prompts/x.md");
	});
	it("resolves relative paths against configFileDir, NOT against cwd (codex round-4)", () => {
		// Critical: this argument is now configFileDir, not cwd. Without this,
		// a malicious repo could shadow a global cron's prompts/ folder.
		expect(resolveGlobalPromptPath("prompts/x.md", "/home/user/.pi/cron.d", "/home/user")).toBe(
			"/home/user/.pi/cron.d/prompts/x.md",
		);
	});
});

// =============================================================================
// resolveJobPrompt — top-level dispatcher
// =============================================================================

describe("resolveJobPrompt", () => {
	let home: string;
	let cwd: string;
	beforeEach(() => {
		home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-rj-home-")));
		cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-rj-cwd-")));
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("local source: routes through validateLocalPromptPath (rejects ~/)", () => {
		const job = makeJob({ source: "local", promptPath: "~/.ssh/id_rsa" });
		const r = resolveJobPrompt(job, cwd, home);
		expect(r.ok).toBe(false);
	});

	it("global source: allows ~/ if file exists", () => {
		const file = path.join(home, "p.md");
		fs.writeFileSync(file, "hi");
		const job = makeJob({ source: "global", promptPath: "~/p.md" });
		const r = resolveJobPrompt(job, cwd, home);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.resolved).toBe(file);
	});

	it("global source: surfaces 'not found' if file missing", () => {
		const job = makeJob({ source: "global", promptPath: "~/missing.md" });
		const r = resolveJobPrompt(job, cwd, home);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/not found/);
	});

	it("global source: relative paths resolve against configFile dir, NOT cwd (codex round-4 #1)", () => {
		// Set up a global cron at $HOME/.pi/cron.d/x.cron with prompt: prompts/x.md.
		// The actual prompt lives next to the cron file, NOT in the session cwd.
		const cronD = path.join(home, ".pi", "cron.d");
		fs.mkdirSync(path.join(cronD, "prompts"), { recursive: true });
		const real = path.join(cronD, "prompts", "x.md");
		fs.writeFileSync(real, "real prompt");
		// Plant a HOSTILE same-named file in cwd. With the old (cwd-relative)
		// behavior this is what would get read. With the round-4 fix it is
		// silently ignored - the configFile dir wins.
		fs.mkdirSync(path.join(cwd, "prompts"));
		fs.writeFileSync(path.join(cwd, "prompts", "x.md"), "HIJACKED prompt");

		const job = makeJob({
			source: "global",
			promptPath: "prompts/x.md",
			configFile: path.join(cronD, "x.cron"),
		});
		const r = resolveJobPrompt(job, cwd, home);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.resolved).toBe(real);
			expect(fs.readFileSync(r.resolved, "utf-8")).toBe("real prompt");
		}
	});
});

// =============================================================================
// isReadableRegularFile + crash-safety guards (codex round-2 finding A)
// =============================================================================

describe("isReadableRegularFile", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-rrf-")));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("ACCEPTS a regular readable file", () => {
		const f = path.join(tmp, "x.md");
		fs.writeFileSync(f, "hi");
		expect(isReadableRegularFile(f).ok).toBe(true);
	});

	it("REJECTS a directory", () => {
		const r = isReadableRegularFile(tmp);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/not a regular file/);
	});

	it("REJECTS a missing path", () => {
		const r = isReadableRegularFile(path.join(tmp, "ghost.md"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/stat failed/);
	});
});

describe("resolveJobPrompt — file-type guard", () => {
	let cwd: string;
	let home: string;
	beforeEach(() => {
		cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-jp-cwd-")));
		home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-jp-home-")));
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("REJECTS local-source job whose prompt path is a directory (would crash readFileSync)", () => {
		fs.mkdirSync(path.join(cwd, "subdir"));
		const job = makeJob({ source: "local", promptPath: "subdir", configFile: "/c.cron" });
		const r = resolveJobPrompt(job, cwd, home);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/not a regular file/);
	});

	it("REJECTS global-source job whose prompt path is a directory", () => {
		fs.mkdirSync(path.join(home, "promptdir"));
		const job = makeJob({ source: "global", promptPath: "~/promptdir", configFile: "/c.cron" });
		const r = resolveJobPrompt(job, cwd, home);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/not a regular file/);
	});
});

// =============================================================================
// prepareCronDispatch — pure dispatch preparation
// =============================================================================

describe("prepareCronDispatch", () => {
	let cwd: string;
	let home: string;
	beforeEach(() => {
		cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-prep-cwd-")));
		home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-prep-home-")));
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("returns ok with tagged content for valid local job", () => {
		fs.writeFileSync(path.join(cwd, "p.md"), "hello world\n");
		const job = makeJob({ name: "j1", source: "local", promptPath: "p.md", configFile: "/x.cron" });
		const r = prepareCronDispatch(job, cwd, home);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.promptContent).toBe("hello world");
			expect(r.tagged).toBe("[cron: j1]\nhello world");
		}
	});

	it("returns reason when prompt is a directory", () => {
		fs.mkdirSync(path.join(cwd, "dir"));
		const job = makeJob({ source: "local", promptPath: "dir" });
		const r = prepareCronDispatch(job, cwd, home);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/not a regular file/);
	});

	it("returns reason when prompt file is empty", () => {
		fs.writeFileSync(path.join(cwd, "empty.md"), "");
		const job = makeJob({ source: "local", promptPath: "empty.md" });
		const r = prepareCronDispatch(job, cwd, home);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/empty/);
	});

	it("returns reason when local prompt tries to escape repo via ~", () => {
		const job = makeJob({ source: "local", promptPath: "~/secret" });
		const r = prepareCronDispatch(job, cwd, home);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/cannot use ~/);
	});
});

// =============================================================================
// Send-then-persist ordering (codex round-2 finding B): if sendUserMessage
// throws, fire history must NOT be persisted, so the next tick can retry.
// =============================================================================

describe("send-then-persist ordering", () => {
	let cwd: string;
	let stateDir: string;
	let job: CronJob;
	beforeEach(() => {
		cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-stp-cwd-")));
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-stp-state-"));
		fs.writeFileSync(path.join(cwd, "p.md"), "do the thing");
		job = makeJob({
			name: "stp",
			source: "local",
			promptPath: "p.md",
			configFile: path.join(cwd, "stp.cron"),
		});
	});
	afterEach(() => {
		for (const d of [cwd, stateDir]) fs.rmSync(d, { recursive: true, force: true });
	});

	/**
	 * Simulates the dispatch ordering used by fireOneJob: prepare → send → persist.
	 * If the supplied send function throws, persist must NOT happen.
	 */
	function dispatch(sendUserMessage: (content: string) => void): { sent: boolean; threw?: string } {
		const prep = prepareCronDispatch(job, cwd, "/nope-no-home");
		if (!prep.ok) return { sent: false };
		try {
			sendUserMessage(prep.tagged);
			appendJobMessage(job, prep.promptContent, stateDir);
			return { sent: true };
		} catch (err) {
			return { sent: false, threw: err instanceof Error ? err.message : String(err) };
		}
	}

	it("appends fire history when send succeeds", () => {
		expect(getJobEntryCount(job, stateDir)).toBe(0);
		const r = dispatch(() => {
			/* succeeds */
		});
		expect(r.sent).toBe(true);
		expect(getJobEntryCount(job, stateDir)).toBe(1);
	});

	it("does NOT append fire history when send throws", () => {
		expect(getJobEntryCount(job, stateDir)).toBe(0);
		const r = dispatch(() => {
			throw new Error("delivery rejected: agent busy");
		});
		expect(r.sent).toBe(false);
		expect(r.threw).toMatch(/delivery rejected/);
		// Critical assertion: no fire was persisted, so getLastFireTime is null,
		// so shouldFire on the next tick will fire again. Without this ordering,
		// the daily cron would silently miss its window.
		expect(getJobEntryCount(job, stateDir)).toBe(0);
		expect(getLastFireTime(job, stateDir)).toBeNull();
	});
});


// =============================================================================
// End-to-end firing simulation — composes the same exported functions the
// extension's setInterval callback uses internally, with vi.useFakeTimers so
// synthetic times line up with what appendJobMessage stamps.
// =============================================================================

describe("firing simulation — what one timer tick does", () => {
	let home: string;
	let cwd: string;
	let stateDir: string;

	beforeEach(() => {
		home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-sim-home-")));
		cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-sim-cwd-")));
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-sim-state-"));

		// Job config under HOME (global). Per the round-4 fix, relative prompt
		// paths in global jobs resolve against the cron file's dir, NOT cwd -
		// so the prompt file goes next to the .cron file.
		const cronD = path.join(home, ".pi", "cron.d");
		fs.mkdirSync(cronD, { recursive: true });
		fs.writeFileSync(
			path.join(cronD, "ping.cron"),
			"name: ping\nprompt: ping-prompt.md\ncron: * * * * *\ndescription: ping the user\n",
		);
		fs.writeFileSync(path.join(cronD, "ping-prompt.md"), "Reply with pong.\n");
	});

	afterEach(() => {
		for (const d of [home, cwd, stateDir]) fs.rmSync(d, { recursive: true, force: true });
	});

	type FireResult = { fired: boolean; payload?: string; error?: string };

	function simulateTick(now: Date): FireResult {
		vi.setSystemTime(now);
		const jobs = loadAllJobs(home, cwd);
		expect(jobs).toHaveLength(1);
		const job = jobs[0];
		expect(job.source).toBe("global");

		const lastFire = getLastFireTime(job, stateDir);
		if (!shouldFire(job, now, lastFire)) return { fired: false };

		const r = resolveJobPrompt(job, cwd, home);
		if (!r.ok) return { fired: false, error: r.error };
		const promptContent = fs.readFileSync(r.resolved, "utf-8").trim();
		appendJobMessage(job, promptContent, stateDir);
		return { fired: true, payload: `[cron: ${job.name}]\n${promptContent}` };
	}

	it("first tick fires, second tick within 60s is suppressed, third tick after window fires again", () => {
		const t0 = new Date(2026, 3, 26, 14, 30, 0);
		const t1 = new Date(t0.getTime() + 30_000);
		const t2 = new Date(t0.getTime() + 90_000);

		vi.useFakeTimers({ now: t0, toFake: ["Date"] });
		try {
			const r0 = simulateTick(t0);
			expect(r0.fired).toBe(true);
			expect(r0.payload).toContain("[cron: ping]");
			expect(r0.payload).toContain("Reply with pong.");

			expect(simulateTick(t1).fired).toBe(false);
			expect(simulateTick(t2).fired).toBe(true);

			const jobs = loadAllJobs(home, cwd);
			expect(getJobEntryCount(jobs[0], stateDir)).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("ticks at non-matching minutes don't fire even when never-fired-before", () => {
		const cronD = path.join(home, ".pi", "cron.d");
		fs.writeFileSync(path.join(cronD, "ping.cron"), "name: ping\nprompt: ping-prompt.md\ncron: 0 12 * * *\n");
		const at1430 = new Date(2026, 3, 26, 14, 30);
		expect(simulateTick(at1430).fired).toBe(false);
		const jobs = loadAllJobs(home, cwd);
		expect(getJobEntryCount(jobs[0], stateDir)).toBe(0);
	});
});

// =============================================================================
// End-to-end SECURITY simulation — proves a malicious local .cron file
// CANNOT exfiltrate $HOME files. This is the critical regression guard.
// =============================================================================

describe("SECURITY: malicious local .cron blocked end-to-end", () => {
	let home: string;
	let cwd: string;
	let stateDir: string;

	beforeEach(() => {
		home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-sec-home-")));
		cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-sec-cwd-")));
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-sec-state-"));

		// Plant a "secret" in the fake home dir
		fs.writeFileSync(path.join(home, "secret.txt"), "TOP_SECRET_API_KEY=xxxxx");

		// Plant a malicious local .cron file that tries to read it
		const cronD = path.join(cwd, ".pi", "cron.d");
		fs.mkdirSync(cronD, { recursive: true });
	});
	afterEach(() => {
		for (const d of [home, cwd, stateDir]) fs.rmSync(d, { recursive: true, force: true });
	});

	function attemptExfil(promptValue: string): { fired: boolean; error?: string } {
		const cronD = path.join(cwd, ".pi", "cron.d");
		fs.writeFileSync(path.join(cronD, "evil.cron"), `name: evil\nprompt: ${promptValue}\ncron: * * * * *\n`);
		const jobs = loadAllJobs(home, cwd);
		expect(jobs).toHaveLength(1);
		expect(jobs[0].source).toBe("local");
		const r = resolveJobPrompt(jobs[0], cwd, home);
		if (!r.ok) return { fired: false, error: r.error };
		// Would have read this content and dispatched it to the LLM provider
		return { fired: true };
	}

	it("blocks ~/secret.txt", () => {
		const r = attemptExfil("~/secret.txt");
		expect(r.fired).toBe(false);
		expect(r.error).toMatch(/cannot use ~/);
	});

	it("blocks absolute path to the secret", () => {
		const r = attemptExfil(path.join(home, "secret.txt"));
		expect(r.fired).toBe(false);
		expect(r.error).toMatch(/absolute/);
	});

	it("blocks symlink in repo pointing to ~/secret.txt", () => {
		fs.symlinkSync(path.join(home, "secret.txt"), path.join(cwd, "innocent.md"));
		const r = attemptExfil("innocent.md");
		expect(r.fired).toBe(false);
		expect(r.error).toMatch(/outside the repo/);
	});

	it("blocks ../traversal to home", () => {
		const traversal = path.relative(cwd, path.join(home, "secret.txt"));
		const r = attemptExfil(traversal);
		expect(r.fired).toBe(false);
		expect(r.error).toMatch(/outside the repo/);
	});

	it("ALLOWS a benign repo-relative prompt (sanity check the fence isn't too tight)", () => {
		fs.writeFileSync(path.join(cwd, "ok.md"), "Tell me a joke.");
		const r = attemptExfil("ok.md");
		expect(r.fired).toBe(true);
	});

	it("a malicious job NAME cannot escape the cron state directory (codex round-3 #1)", () => {
		// Plant a benign prompt so prompt-path validation passes; the attack here
		// is via job NAME, not prompt path.
		fs.writeFileSync(path.join(cwd, "ok.md"), "innocent prompt");
		const cronD = path.join(cwd, ".pi", "cron.d");
		fs.writeFileSync(path.join(cronD, "evil.cron"), "name: ../../sneak\nprompt: ok.md\ncron: * * * * *\n");
		const jobs = loadAllJobs(home, cwd);
		expect(jobs).toHaveLength(1);
		const job = jobs[0];

		// The state file path MUST live inside stateDir, never escape via the name.
		const sessionPath = getJobSessionPath(job, stateDir);
		expect(path.dirname(sessionPath)).toBe(stateDir);

		// Append + read should work without any path traversal.
		appendJobMessage(job, "ok", stateDir);
		const written = fs.readdirSync(stateDir);
		expect(written).toHaveLength(1);
		// And the filename must be slugged — no .. or / fragments.
		expect(written[0]).not.toMatch(/\.\./);
		expect(written[0]).not.toContain("/");
	});
});


// Suppress unused-import lint; both types are referenced via type position above.
const _typecheck: { entry?: JobEntry } = {};
void _typecheck;
