# Headless deployment via systemd

Use these unit files to run pi-cron on a VM (or any always-on Linux box) without
needing to keep an interactive pi session open. Once installed, the timer fires
the runner every minute, and any due cron jobs spawn their own pi subprocess.

## Prerequisites

1. Node 22+ on the VM
2. `pi` (`@mariozechner/pi-coding-agent`) installed and in `PATH`
3. `pi-cron` installed (`git clone` into `~/.pi/agent/extensions/pi-cron` or
   `npm install -g pi-cron`)
4. At least one auth method configured for pi (env var `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, etc., or `~/.pi/agent/auth.json` from a prior `pi` run)
5. Your `.cron` files in `~/.pi/cron.d/` and prompt files wherever you reference
   them

## Install

```bash
# 1. Edit the .service file to match YOUR username and install path.
#    Required edits:
#      User=  / Group=                  → your unix user
#      ReadWritePaths=/home/USER/.pi    → match the user's home
#      ExecStart=/usr/local/bin/...     → wherever pi-cron-runner lives
$EDITOR examples/systemd/pi-cron-runner.service

# 2. Drop the units into systemd's directory.
sudo cp examples/systemd/pi-cron-runner.service /etc/systemd/system/
sudo cp examples/systemd/pi-cron-runner.timer   /etc/systemd/system/

# 3. Reload + enable + start.
sudo systemctl daemon-reload
sudo systemctl enable --now pi-cron-runner.timer

# 4. Verify.
systemctl list-timers pi-cron-runner.timer
journalctl -u pi-cron-runner.service -n 50 -f
```

## Verify it's working

```bash
# Manually trigger one tick.
sudo systemctl start pi-cron-runner.service
journalctl -u pi-cron-runner.service -n 100

# Or run the runner directly (skip systemd) for a fast smoke test.
pi-cron-runner --jobs       # list what would run
pi-cron-runner              # actually do one tick
```

## Notes

- **No daemon.** The timer fires the runner; the runner runs once and exits.
  Memory-cheap, restart-safe.
- **Catches missed schedules.** `Persistent=true` in the timer means missed
  ticks during downtime fire on next boot. The runner's `findMostRecentDueMinute`
  then catches the actual matching minute (up to 24h back for previously-fired
  jobs, 5min back for never-fired).
- **Hardening.** The included `.service` enables `NoNewPrivileges`, `PrivateTmp`,
  and `ProtectSystem=strict` with an explicit `ReadWritePaths` for `~/.pi/`.
  Lock down further if you don't need write access to other directories
  (cron jobs that write to `~/briefs/` need that path added).
- **Auth.** The runner inherits the user's environment, which is read by the
  `pi` subprocess. If your pi auth depends on env vars set in `~/.bashrc` or
  similar (not loaded for systemd services), use `EnvironmentFile=` in the
  `.service` to source them.
- **Logs.** `StandardOutput=journal` routes runner logs to journald. Browse
  with `journalctl -u pi-cron-runner.service`. The agent's actual responses
  (subprocess stdout) are also captured here, but the cron prompts should
  direct any real output to disk/webhook themselves.
