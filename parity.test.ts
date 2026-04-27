/**
 * Parity tests: bin/pi-cron-runner.mjs INLINES several helpers from cron.ts
 * (because the runner is plain JS without a build step). The two implementations
 * MUST stay behaviorally identical. These tests run the same inputs through
 * both sides and assert equal outputs.
 *
 * If you change a helper in cron.ts, update the inlined version in
 * pi-cron-runner.mjs to match - or this suite goes red.
 */

import { describe, expect, it } from "vitest";
import * as ext from "./cron.js";
// @ts-expect-error - .mjs has no type declarations; we only call exported
// runtime functions. Imports work fine, types are just `any`.
import * as runner from "./bin/pi-cron-runner.mjs";

const cronExpressions = [
	"* * * * *",
	"0 * * * *",
	"*/15 * * * *",
	"0,30 * * * *",
	"0 12 * * *",
	"0 0 1 * *",
	"0 0 * * 0",
	"0 0 * * 7", // DOW 7 normalization
	"0 0 1 * 1", // POSIX OR semantics
	"55-99 * * * *", // out-of-range clamp
	"1-10/2 * * * *", // stepped range
	"0-1000000000/1 * * * *", // CPU-safety clamp
];

const sampleDates = [
	new Date(2026, 3, 26, 0, 0), // Sunday midnight
	new Date(2026, 3, 26, 12, 0), // Sunday noon
	new Date(2026, 3, 27, 9, 30), // Monday 9:30am
	new Date(2026, 3, 1, 0, 0), // Wednesday the 1st
	new Date(2026, 11, 31, 23, 59), // year-end edge
];

describe("parity: parseCronField", () => {
	for (const expr of ["*", "0", "*/15", "0,15,45", "1-10/2", "0-30/10", "55-99", "0-1000000000/1", "*/0", "nope"]) {
		it(`parses "${expr}" identically`, () => {
			for (const max of [60, 24, 32, 13, 7, 8]) {
				expect(runner.parseCronField(expr, max)).toEqual(ext.parseCronField(expr, max));
			}
		});
	}
});

describe("parity: matchesCron", () => {
	for (const expr of cronExpressions) {
		for (const d of sampleDates) {
			it(`matches "${expr}" at ${d.toISOString()} identically`, () => {
				expect(runner.matchesCron(expr, d)).toBe(ext.matchesCron(expr, d));
			});
		}
	}
});

describe("parity: floorToMinute", () => {
	for (const d of sampleDates) {
		it(`floors ${d.toISOString()} identically`, () => {
			expect(runner.floorToMinute(d).getTime()).toBe(ext.floorToMinute(d).getTime());
		});
	}
});

describe("parity: findMostRecentDueMinute", () => {
	const job = {
		name: "j",
		promptPath: "p.md",
		cronExpression: "0 12 * * *",
		source: "global" as const,
		configFile: "/tmp/j.cron",
	};
	const now = new Date(2026, 3, 27, 12, 0, 30);
	const cases = [
		{ lastFire: null, loadMs: now.getTime() - 60_000 },
		{ lastFire: null, loadMs: 0 },
		{ lastFire: now.getTime() - 25 * 60 * 60 * 1000, loadMs: 0 },
		{ lastFire: now.getTime() - 30_000, loadMs: 0 },
		{ lastFire: now.getTime() - 90_000, loadMs: 0 },
	];
	for (const [i, c] of cases.entries()) {
		it(`case ${i}: lastFire=${c.lastFire}, loadMs=${c.loadMs}`, () => {
			const a = ext.findMostRecentDueMinute(job, now, c.lastFire, c.loadMs);
			const b = runner.findMostRecentDueMinute(job, now, c.lastFire, c.loadMs);
			expect(b?.getTime() ?? null).toBe(a?.getTime() ?? null);
		});
	}
});

describe("parity: safeNameSlug", () => {
	for (const name of ["foo", "my-job_v2", "../../etc/passwd", "..", ".hidden", "", "a/b\\c", "a".repeat(500)]) {
		it(`slugs "${name}" identically`, () => {
			expect(runner.safeNameSlug(name)).toBe(ext.safeNameSlug(name));
		});
	}
});

describe("parity: configHash", () => {
	for (const p of ["/a", "/b/c", "/very/long/path/to/a.cron", ""]) {
		it(`hashes "${p}" identically`, () => {
			expect(runner.configHash(p)).toBe(ext.configHash(p));
		});
	}
});

describe("parity: buildSubprocessArgs", () => {
	const cases = [
		["/path/to/x.jsonl", "[cron: foo]\nDo X"],
		["/", "''"],
		["/p with spaces.jsonl", "multi\nline\nprompt"],
	];
	for (const [sessionPath, prompt] of cases) {
		it(`builds args for ${sessionPath} identically`, () => {
			expect(runner.buildSubprocessArgs(sessionPath, prompt)).toEqual(ext.buildSubprocessArgs(sessionPath, prompt));
		});
	}
});

describe("parity: getJobSessionPath + getTaskSessionPath", () => {
	const job = { name: "ping", configFile: "/etc/foo.cron" };
	it("getJobSessionPath result is identical", () => {
		expect(runner.getJobSessionPath(job, "/state")).toBe(ext.getJobSessionPath(job, "/state"));
	});
	it("getTaskSessionPath result is identical", () => {
		expect(runner.getTaskSessionPath(job, "/sessions")).toBe(ext.getTaskSessionPath(job, "/sessions"));
	});
});
