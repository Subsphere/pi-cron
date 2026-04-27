# pi-cron

Schedule prompts to fire on a wall-clock interval. Each cron task is its own **persistent pi conversation** with its own memory across runs. Your main pi session is never touched.

```
~/.pi/cron.d/morning.cron
  cron: 0 9 * * 1-5
  prompt: ~/prompts/morning-standup.md
                ↓
        every weekday 9am
                ↓
   spawn: pi -p -c --session ~/.pi/cron-sessions/morning-abc.jsonl "<prompt>"
                ↓
   subprocess loads yesterday's standup, day-before's, ...
   subprocess runs the agent, writes ~/standups/today.md (per the prompt)
   subprocess exits cleanly
                ↓
   YOUR INTERACTIVE PI SESSION: completely undisturbed
```

Two deployment modes, **same `.cron` file format and same per-task sessions**:

| Mode | When | What | Use case |
|---|---|---|---|
| **Extension** (in-pi) | While pi is open | `cron.ts` registers a setInterval that ticks every 60s | Laptop, you keep pi running, want crons alongside interactive work |
| **Runner CLI** (headless) | Whenever the machine is on | `pi-cron-runner` spawned by systemd timer once per minute | VM, server, "deploy and never SSH again" |

You can use both — laptop fires while pi is open, VM fires the rest of the time, against the same session files synced via git/rsync.

---

## Install

### Mode A: Extension (laptop, while pi is running)

```bash
git clone https://github.com/Subsphere/pi-cron.git ~/.pi/agent/extensions/pi-cron
cd ~/.pi/agent/extensions/pi-cron
npm install
```

Pi auto-discovers any directory under `~/.pi/agent/extensions/` with a `package.json` containing `"pi": { "extensions": [...] }`. Restart pi (or open a new session). You should see:

```
Cron extension loaded: 0 job(s) (0 global, 0 local).
```

### Mode B: Runner CLI (headless VM, runs without pi)

```bash
# 1. Install pi-cron globally (puts pi-cron-runner in PATH)
npm install -g github:Subsphere/pi-cron

# 2. Verify
pi-cron-runner --version
pi-cron-runner --jobs

# 3. Set up systemd timer (see examples/systemd/INSTALL.md for full details)
sudo cp $(npm root -g)/pi-cron/examples/systemd/*.{service,timer} /etc/systemd/system/
$EDITOR /etc/systemd/system/pi-cron-runner.service   # set User= to your user
sudo systemctl daemon-reload
sudo systemctl enable --now pi-cron-runner.timer
```

That's it. Done. Tick fires every minute, due jobs run as pi subprocesses, output goes wherever your prompts direct it. No pi process to babysit.

---

## Your first cron

Two files (one .cron config, one prompt):

```bash
mkdir -p ~/.pi/cron.d ~/.pi/cron-prompts

cat > ~/.pi/cron.d/check-time.cron <<'EOF'
name: check-time
prompt: ~/.pi/cron-prompts/check-time.md
cron: */5 * * * *
description: Log the time every 5 minutes
EOF

cat > ~/.pi/cron-prompts/check-time.md <<'EOF'
Run `date -u` via bash and append the result with a timestamp to
~/cron-results/uptime.log. Reply only "logged".
EOF
```

Restart pi (extension mode) or just wait (runner mode). Every 5 minutes the cron fires. Your `~/cron-results/uptime.log` grows. Your main pi session is never touched.

In pi, run `/cron` to see what's registered:

```
[global] check-time  cron: */5 * * * *  -  Log the time every 5 minutes  (last: 2026-04-27 09:05:00, 1 fires, session: ✓)
```

---

## How a cron task does work — there's no separate output config

The agent has full pi tools (bash, write, edit, read, etc.). Anything you can ask interactive pi to do, you can put in a cron prompt. Output destinations are just instructions in the prompt:

```markdown
# Write to disk
Run `git log --since=24h --oneline` in /opt/myrepo, summarize into 5 bullets,
write to ~/briefs/$(date +%F).md via the Write tool. Don't display, just confirm
the file path.

# POST to a webhook
Use bash to curl https://internal/api/queue-depth.
If JSON.depth > 100, curl -X POST https://hooks.slack.com/... with body
{"text":"queue at ${depth}"}. Otherwise reply "ok, depth ${depth}".

# Send an email (via mailx or whatever's available)
Check /var/log/syslog for any "ERROR" since the last hour. If found, mail the
extracted lines to ops@example.com via `mail -s "syslog errors" ops@example.com`.
```

No new config fields needed. The agent figures it out from the prompt.

---

## Per-task sessions (the architecture)

Each cron task has TWO files:

| File | What | Sent to LLM? |
|---|---|---|
| `~/.pi/cron-sessions/<slug>-<hash>.jsonl` | Real pi conversation history. Loaded on each fire so the agent has memory of past runs. | **Yes** — this IS the conversation. |
| `~/.pi/cron/<slug>-<hash>.jsonl` | Fire-log metadata: when did this job last fire, what was the dispatched prompt. Used by `/cron` listings + dedup window. | **No** — local metadata only. |

`<slug>` is the job name sanitized to filename-safe characters. `<hash>` is the first 10 hex chars of `sha256(configFilePath)`. So a global "ping" and a local "ping" never collide — different config files → different hashes → different state.

To **read what a cron has been "thinking"** across runs, drop into its session interactively:

```bash
# In pi:
/cron-open morning-brief

# Or directly:
pi --session ~/.pi/cron-sessions/morning-brief-<hash>.jsonl
```

That opens the cron's full conversation history as if it were any other pi session. You can ask follow-up questions, read past responses, or just observe the accumulated context.

---

## Trust model — `global` vs `local`

The single most important thing about the security model.

| Source | Discovered from | Trust | Prompt paths allowed |
|---|---|---|---|
| **global** | `~/.pi/cron.d/*.cron` | trusted (you placed it) | `~/`, absolute, or relative-to-the-`.cron`-file |
| **local** | `<cwd>/.pi/cron.d/*.cron` | **untrusted** (whoever wrote the repo) | repo-relative only, no symlinks escaping the repo |

**Why this matters:** without the local restriction, opening a malicious repo would let a `.cron` file inside it say `prompt: ~/.ssh/id_rsa` and the cron would happily read your SSH private key, tag it, and send it to your LLM provider on the next tick. Because the cron fires in the background, you might not even see it happen.

The extension blocks every variant of this attack:

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

## Catch-up scheduler

The scheduler is **catch-up aware** in both deployment modes. Instead of only checking the current minute when each tick fires, it walks backwards from `now` looking for the most recent matching minute that hasn't already been fired:

- **Open pi at 12:00:05** — a `0 12 * * *` cron still fires at 12:00 (within the 5-minute first-time lookback).
- **Laptop sleep 12:30 → 14:00** — a `0 13 * * *` cron fires at 13:00 on the next tick after wake (within the 24-hour previously-fired lookback).
- **Frequent crons during a long sleep** — a `* * * * *` cron sleeping for 30 minutes fires once at the most-recent matching minute, not 30 times.

Caps:
- Never-fired job lookback: **5 minutes** (and never before extension/runner load — no surprise stale fires)
- Previously-fired job lookback: **24 hours** (covers daily crons across overnight sleep)
- A 48h+ sleep with a daily cron will still miss the day before last — documented behavior, not a bug

---

## Slash commands (extension mode)

| Command | What it does |
|---|---|
| `/cron` | List registered jobs (source, schedule, last-fired, fire count, session-file presence) |
| `/cron-open <name>` | Print the command to drop into a cron's conversation interactively |
| `/cron-remove <name>` | Remove a job from in-memory list (config file untouched, fire log cleared, per-task session preserved — delete manually if you want a clean slate) |

---

## Recursion guard (technical)

The cron extension spawns `pi` as a subprocess. If that subprocess loaded the cron extension and started its own scheduler, you'd get infinite recursion. Two complementary guards prevent this:

1. **`--no-extensions` flag** in the subprocess invocation. Pi's loader skips auto-discovery, so this extension never loads in the spawned pi. Built-in tools (bash, write, edit, read) still work normally — they're not extensions.
2. **`PI_CRON_SUBPROCESS=1` env var** set by the runner CLI. The cron extension's `session_start` handler checks for this and skips scheduling. Belt-and-suspenders for the runner case where someone might disable `--no-extensions`.

---

## Limitations

- **Wall-clock fires only when something is running.** Extension mode requires pi to be open. Runner mode requires the systemd timer to be active. If both are off, schedules are missed (catch-up restores up to 24h on next start).
- **Subprocess startup cost.** Each cron fire spawns a fresh `pi` process. ~1-3 seconds startup. For sub-minute crons (`* * * * *`) this is fine. For sub-second granularity, this isn't the right tool.
- **No multi-process locking on state files.** If you run the extension AND the runner against the same `~/.pi/` simultaneously, both schedulers can dispatch the same job (double-fire) and corrupt the JSONL state file. Pick one mode per `~/.pi/`. (Or run them in different `HOME`s if you really want both.)
- **One cron task at a time per tick.** Both extension and runner serialize jobs within a tick (one `await pi.exec` at a time). If a cron task takes 5 minutes, no other crons in the same tick fire until it completes. The next tick still fires on schedule.

---

## Compatibility with pi upstream

The extension uses only the public `ExtensionAPI` and `ExtensionContext` interfaces from `@mariozechner/pi-coding-agent`. Type-only imports get stripped at runtime, so the only true coupling is whatever surface pi keeps stable across versions.

`package.json` declares the peer dep as `^0.70.0`, allowing minor and patch bumps within `0.70.x`. Tested against pi-coding-agent **0.70.2**.

The runner CLI (`bin/pi-cron-runner.mjs`) doesn't depend on pi's API surface at all — it spawns pi as a subprocess via `node:child_process`. As long as pi's CLI flags (`-p`, `-c`, `--session`, `--no-extensions`) stay stable, the runner survives any internal API changes.

---

## Development

```bash
npm install
npm test          # 217 vitest tests (cron + parity)
```

Tests cover:

- `parseCronField`, `matchesCron`, `findMostRecentDueMinute` — schedule logic
- `validateLocalPromptPath` — every documented attack (10 cases)
- `safeNameSlug` + `getJobSessionPath` + `getTaskSessionPath` — name traversal containment
- `configHash` + state isolation — global vs local same-name doesn't collide
- `prepareCronDispatch` — directory/empty/escape rejection
- `buildSubprocessArgs` — subprocess invocation contract (--no-extensions, --session path, prompt as last arg)
- `spawn-then-persist` ordering — exit-zero persists fire log, exit-nonzero does NOT
- end-to-end SECURITY simulation — malicious local `.cron` blocked at every layer
- end-to-end firing simulation — multi-tick dedup with `vi.useFakeTimers`
- **parity** — runner's inlined helpers MUST match the extension's exports for every sampled input

Integration tests against pi's runner live in [pi-mono](https://github.com/mariozechner/pi-coding-agent) and aren't included here (they need pi internals not published from the npm package).

---

## What changed in 0.2.0 (architectural redo)

If you used the 0.1.0 version: the dispatch model has fundamentally changed.

**0.1.0:** cron fired via `pi.sendUserMessage`, prompt landed in your main pi session. Polluted your interactive chat. No real per-task memory — the "state log" was metadata only. No headless mode.

**0.2.0:** cron fires via `pi.exec` subprocess on a per-task session file. Main session never touched. Each cron task accumulates real conversation history across runs. Plus: standalone `pi-cron-runner` CLI for systemd-timer-driven headless deployment.

The `.cron` file format is unchanged. Existing fire-log files in `~/.pi/cron/` continue to work. Per-task session files in `~/.pi/cron-sessions/` are new — they'll be created on first fire after upgrading.

---

## License

MIT, see [LICENSE](./LICENSE).

Built with [pi](https://github.com/mariozechner/pi-coding-agent). Reviewed across 6 rounds of Claude→Codex adversarial review during development.
