# pi-cron

Schedule prompts to fire on a wall-clock interval, even when [pi](https://github.com/mariozechner/pi-coding-agent) is sitting idle.

A `.cron` file says *what* to send and *when*. The extension dispatches it through `pi.sendUserMessage`, so each fired prompt becomes a normal user message in your pi session — same model, same tools, same context.

```
~/.pi/cron.d/morning.cron
  cron: 0 9 * * 1-5
  prompt: ~/prompts/morning-standup.md
                ↓
        every weekday 9am
                ↓
   pi.sendUserMessage("Standup time. Pull yesterday's commits and...")
```

---

## Install

```bash
git clone https://github.com/Subsphere/pi-cron.git ~/.pi/agent/extensions/pi-cron
```

That's it — pi auto-discovers any directory under `~/.pi/agent/extensions/` with a `package.json` that has a `pi.extensions` field. Restart pi (or open a new session) and you should see:

```
Cron extension loaded: 0 job(s) (0 global, 0 local).
```

If you'd rather not clone, the extension is a single file (`cron.ts`) and you can drop it into `~/.pi/agent/extensions/cron.ts` directly.

---

## Your first cron

Two files, one in each of:

```bash
mkdir -p ~/.pi/cron.d ~/.pi/cron-prompts

cat > ~/.pi/cron.d/check-time.cron <<'EOF'
name: check-time
prompt: ~/.pi/cron-prompts/check-time.md
cron: */5 * * * *
description: Ask for the current time every 5 minutes
EOF

cat > ~/.pi/cron-prompts/check-time.md <<'EOF'
Run `date -u` and tell me the current UTC time in one short sentence.
EOF
```

Restart pi. Every 5 minutes you'll see the prompt fire and the agent respond.

Run `/cron` inside pi to list registered jobs:

```
[global] check-time  cron: */5 * * * *  -  Ask for the current time...  (last: 2026-04-27 09:05:00, 1 entries)
```

---

## Trust model — `global` vs `local`

This is the single most important thing to understand about the extension.

| Source | Discovered from | Trust | Prompt paths allowed |
|---|---|---|---|
| **global** | `~/.pi/cron.d/*.cron` | trusted (you placed it) | `~/`, absolute, or relative-to-the-`.cron`-file |
| **local** | `<cwd>/.pi/cron.d/*.cron` | **untrusted** (whoever wrote the repo) | repo-relative only, no symlinks escaping the repo |

**Why this matters:** without the local restriction, opening a malicious repo would let a `.cron` file inside it say `prompt: ~/.ssh/id_rsa` and the extension would happily read your SSH private key, tag it, and send it to your LLM provider on the next tick. Because the cron fires in the background, you might not even see it happen.

The extension blocks this end-to-end:

- ❌ `prompt: ~/.ssh/id_rsa` from local → rejected (no `~/` for local)
- ❌ `prompt: /etc/passwd` from local → rejected (no absolute paths for local)
- ❌ `prompt: ../../etc/passwd` from local → rejected (`..` traversal)
- ❌ `prompt: alias.md` where `alias.md` is a symlink to `/etc/passwd` → rejected (realpath check)
- ❌ `name: ../../escape` from any source → slugged + path-containment check
- ✅ `prompt: prompts/x.md` from local → resolved within the repo

For global jobs, relative paths resolve against the directory of the `.cron` file (e.g. `~/.pi/cron.d/`), **not** the session cwd, so opening a different repo can't shadow your global prompt files either.

Tests for every one of these cases live in `cron.test.ts`.

---

## Cron format

Standard 5-field cron, POSIX-compatible:

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-7, both 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

Each field accepts:

- `*` — every value
- `N` — exact value
- `N-M` — range
- `N-M/S` — stepped range (`1-10/2` = 1, 3, 5, 7, 9)
- `*/S` — step from 0 (`*/15` = 0, 15, 30, 45)
- `A,B,C` — list (or any comma-joined combination of the above)

**POSIX OR semantics:** when both day-of-month AND day-of-week are restricted, the expression matches if either matches (`0 0 1 * 1` = midnight on the 1st OR every Monday). When at least one is `*`, both must match.

Out-of-range values are silently clamped — `parseCronField("0-1000000000/1", 60)` returns `[0..59]` instantly instead of looping a billion times.

---

## Per-task state — what's local, what hits the LLM

Each cron job has its own state file:

```
~/.pi/cron/${slug(name)}-${sha256(configFile).slice(0,10)}.jsonl
```

**This file is local-only metadata.** It records when the job fired and (a snippet of) the prompt that was sent. It is **never** sent to the model. It exists so:

- `/cron` can show you when each job last ran and how many times
- The dedup window can suppress double-fires within 60 seconds
- A global "ping" and a local "ping" never share state (the configFile hash isolates them)

The file auto-compacts at 200 entries (configurable via `MAX_JOB_HISTORY_LINES` in `cron.ts`). Old entries collapse into a single summary; the most recent 50 stay verbatim.

**What does hit the LLM** is the contents of your prompt file (the `.md` referenced by `prompt:`). That's it. There is no separate per-task conversation history — each cron fire is a fresh user message in your main pi session.

---

## Context budget — and pi's `keepRecentTokens`

If you're running pi against a small-context local model (anything under ~64K), repeated cron fires can eat your conversation headroom. The extension watches for this and warns you at 100K tokens by default. It does **not** auto-compact, because of an important pi quirk:

`ctx.compact()` calls pi's compactor, which is governed by your pi `compaction.keepRecentTokens` setting. The default is **20K**. Extensions can't override it per-call. So if the extension auto-called compact for you, your 100K session would shrink to ~25-30K and you'd lose more than you wanted.

**To use the cap effectively:**

1. Set this in your pi settings (`~/.pi/agent/settings.json` or `<repo>/.pi/settings.json`):

   ```json
   {
     "compaction": {
       "keepRecentTokens": 80000
     }
   }
   ```

2. When the cron warns you (`pi session at 105000/262144 tokens, over your 100000 cap...`), run `/compact` yourself.

3. The compacted session lands at ~80K — in your target range.

If you don't care about the cap, set `DEFAULT_MAX_CONTEXT_TOKENS = 0` at the top of `cron.ts` to disable the warning.

---

## Slash commands

| Command | What it does |
|---|---|
| `/cron` | List registered jobs with source, schedule, last-fired time, history depth |
| `/cron-remove <name>` | Remove a job from the in-memory list (the `.cron` file stays on disk; the job returns next session start). Clears the job's state file. |

---

## Catch-up behavior (sleep / wake / late open)

The scheduler is **catch-up aware**. Instead of only checking the current minute when each tick fires, it walks backwards from `now` looking for the most recent matching minute that hasn't already been fired. This handles:

- **Open pi at 12:00:05** — a `0 12 * * *` cron still fires at 12:00 (within the 5-minute first-time lookback).
- **Laptop sleep 12:30 → 14:00** — a `0 13 * * *` cron fires at 13:00 on the next tick after wake (within the 24-hour previously-fired lookback).
- **Frequent crons during a long sleep** — a `* * * * *` cron sleeping for 30 minutes fires once at the most-recent matching minute, not 30 times.

Caps:
- Never-fired job lookback: **5 minutes** (and never before extension load — no surprise stale fires)
- Previously-fired job lookback: **24 hours** (covers daily crons across overnight sleep)
- A 48h+ sleep with a daily cron will still miss the day before last — documented behavior, not a bug

## Limitations

- **Wall-clock fires only when pi is running.** No daemon, no background process. If pi is closed for longer than the 24h lookback, that schedule is missed.
- **`pi.sendUserMessage` is fire-and-forget.** The extension catches synchronous throws (e.g. "agent busy" rejections), so a failed dispatch does NOT mark the job as fired and the next tick retries. But asynchronous failures past queueing (rate limits, model auth errors, network failures) are invisible at the API level — the job appears fired. For one-shot daily SLAs, prefer to verify via `/cron` listing + manual check.
- **The cron's prompt goes into pi's main session, not an isolated conversation.** If you want truly isolated per-task chats, that's an architectural change beyond this extension (would need session forking + correlation).
- **No multi-process locking on state files.** If you run two pi sessions against the same `~/.pi/` simultaneously, both schedulers can dispatch the same job (double-fire) and corrupt the JSONL state file. Single-session use is the supported configuration.

---

## Compatibility with pi upstream

The extension uses only the public `ExtensionAPI` and `ExtensionContext` interfaces from `@mariozechner/pi-coding-agent`. The `import type { ExtensionAPI, ExtensionContext, ContextUsage }` line gets stripped at runtime, so the only true coupling is whatever surface pi keeps stable across versions.

`package.json` declares the peer dep as `^0.70.0`, allowing minor and patch bumps within `0.70.x`. Tested against pi-coding-agent **0.70.2**.

If pi makes breaking API changes in a 0.71.x or 1.0 release, you'll see a TypeScript compile error pointing at the renamed/removed symbol, and the extension simply won't load — no silent corruption. Bump the peer-dep range explicitly when you've validated against the new version.

---

## Development

```bash
npm install
npm test          # 109 vitest tests, all pure functions + simulations
```

Tests cover:

- `parseCronField` — comma/range/step combinations, invalid input, CPU-safety clamp
- `matchesCron` — POSIX OR semantics, DOW 7→0 normalization
- `validateLocalPromptPath` — every documented attack (10 cases)
- `safeNameSlug` + `getJobSessionPath` — name traversal containment
- `configHash` + state isolation — global vs local same-name doesn't collide
- `prepareCronDispatch` — directory/empty/escape rejection
- `shouldFire` — dedup window, regression test for the prior 59-min bug
- `shouldCompactContext` — context cap policy
- `findMostRecentDueMinute` + `floorToMinute` — catch-up scheduler (open-late, sleep/wake, sparse cron after long sleep)
- `loadCronFile` / `findCronFiles` / `loadAllJobs` — hardening so one bad `.cron` entry doesn't kill loading
- end-to-end SECURITY simulation — malicious local `.cron` blocked at every layer
- end-to-end firing simulation — multi-tick dedup with `vi.useFakeTimers`

Integration tests against pi's runner live in [pi-mono](https://github.com/mariozechner/pi-coding-agent) and aren't included here (they need pi internals not published from the npm package).

---

## License

MIT, see [LICENSE](./LICENSE).

Built with [pi](https://github.com/mariozechner/pi-coding-agent). Reviewed across 5 rounds of Claude→Codex adversarial review during development.
