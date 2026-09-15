# Scheduling Plan

How equity-watch runs on its own: a Windows Task Scheduler task runs
`scripts\check-and-publish.ps1` every 15 minutes through the trading day, from
a native Windows checkout.

Status: **ready to set up**. Decided 2026-09-13.

---

## Decision: Task Scheduler on native Windows

| Option | Verdict |
|---|---|
| **Windows Task Scheduler** | **Use this.** Free, no delays, retries missed runs, can wake the PC. State and Schwab tokens stay local, where the tool already expects them. |
| Cron inside WSL | No. Cron only fires while the WSL VM is running, and WSL shuts down when no terminal is open. |
| GitHub Actions | Not now. See below. |

### Why not GitHub Actions

**Cost.** A run does about 4 seconds of work (check 1.3 s, site build 0.8 s,
measured). Runner setup dominates, though: checkout, Node, `npm ci`, build.
GitHub rounds each job up to a whole minute, so a run bills 1-2 minutes. A
private repo on GitHub Free gets 2,000 minutes a month, shared across all
private repos, then $0.006 a minute on Linux.

| Every 15 minutes... | Runs/month | Cost |
|---|---|---|
| 24/7 | ~2,900 | ~$5-23/mo |
| Weekdays, 4 AM-8 PM ET | ~1,500 | free at 1 min/run, ~$6 at 2 |
| Weekdays, regular hours | ~660 | free |

(`optionspread-heatmaps` never hit this: public repos get unlimited minutes.)

**Architecture, which is the real reason.**

- **State.** Every check rewrites `alerts.json`, `revisits.json`, and the
  caches. A runner starts empty, so all of it would have to live in S3 and sync
  in and out each run, and the local files would stop being the source of truth.
- **Schwab tokens.** The refresh token rotates on every refresh and expires
  after 7 days. A runner would need to read and write them somewhere, and every
  weekly login would mean re-uploading them. Static secrets can't do this.
- **Timing.** GitHub's docs say scheduled runs "can be delayed during periods of
  high loads", especially at the start of every hour, and that "some queued jobs
  may be dropped".

**If this moves to the cloud later**, the write-back plan in
`USER_CHANGE_EVENTS_PLAN.md` already needs a cloud component. At that point, use
AWS EventBridge Scheduler plus Lambda, not Actions: no per-minute rounding, no
dropped runs, well inside the free tier, and in the account that already hosts
the site. The weekly Schwab login stays manual either way.

### Known weakness: the PC must be on

If the PC is off, asleep with wake disabled, or rebooting for updates, alerts
stop silently and the dashboard goes stale. Mitigations:

1. **Wake to run**, set on the task below.
2. **A dead-man's switch.** Create a free check at
   [healthchecks.io](https://healthchecks.io) with a 15-minute period and a grace
   time covering overnight gaps, or a cron-style schedule matching the task, and
   put its ping URL in `.env` as `HEALTHCHECK_URL`. The script pings it after
   every run, and `<url>/fail` on failure, so a missed or failing run emails you.

---

## Time zones (verified 2026-09-13)

This machine runs **Mountain time with DST**. Windows reports the zone ID
`Mountain Standard Time`, which despite its name observes DST; Arizona's
no-DST zone is `US Mountain Standard Time`. WSL and Node agree
(`America/Denver`, currently MDT, UTC-6). The exchange runs **Eastern**, and both
zones change clocks on the same dates, so Mountain is always exactly 2 hours
behind Eastern.

| Session (Eastern) | Mountain (this machine, Task Scheduler) |
|---|---|
| Pre-market 04:00-09:30 | 02:00-07:30 |
| Regular 09:30-16:00 | 07:30-14:00 |
| After hours 16:00-20:00 | 14:00-18:00 |
| Half days: regular ends 13:00 | 11:00 |

**What the code does, checked line by line:**

- **Market logic is correct in any zone.** Sessions come from Schwab's market-hours
  API as absolute instants. Trading dates and intraday bar buckets use
  `America/New_York` explicitly (`marketDate`, `src/timezone.ts`). The
  scheduler window above is only about when the task wakes; `alert check`
  decides from Schwab's hours whether a session is open, including holidays and
  half days.
- **The browser dashboard** formats times in the viewer's own zone.
- **Terminal output and report file names** use the machine's local time.

**Bugs found and fixed in the same change:**

1. **TradingView export times were read as UTC.** They're Mountain time: that's
   the TradingView account's display zone. Evidence: 129 of 258 alert-log rows
   fall in the 07:00 hour and 59 at exactly 7:30, which is the 9:30 Eastern open.
   Schwab minute bars show LUMN, CF, and BP crossing their levels at 13:30 UTC,
   and at 07:30 UTC there are no bars at all. `seed.ts` now parses both exports in
   `America/Denver`. The already-imported `watchingSince` values in `alerts.json`
   were shifted by the zone offset to match.
2. **Intraday volume baselines matched time of day in UTC.** For about 10 sessions
   after each DST change, past sessions were compared an hour off. They now match
   on the Eastern clock.
3. **A "today" volume alert stayed muted only until UTC midnight.** In winter
   that's 19:00 Eastern, an hour before after-hours ends, so it could fire twice
   in one day. The mute now lasts until Eastern midnight.
4. **"Price when watching started" took the day after the first trigger's close**
   (bar timestamps vs. an intraday time). It now uses the close of the trigger's
   own trading day. Already-imported `priceAtWatchStart` values were not
   recomputed, so they remain one session late.
5. **Smaller:** the terminal dashboard header printed UTC unlabeled; the default
   holdings purchase date and dashboard report file name used UTC dates. All
   now use local time.

---

## One-time setup on Windows

Run these in **cmd** (not WSL). Paths assume the repo lives at
`%USERPROFILE%\projects\equity-watch` and the WSL distro is `Ubuntu-24.04`.

### 1. Check out and build

```bat
cd /d %USERPROFILE%\projects
git clone https://github.com/wkbaran/equity-watch.git
cd equity-watch
npm ci
npm run build
```

### 2. Move state over, once

The gitignored state lives in the WSL checkout. Copy it, then **retire the WSL
copies**. Two checkouts both running checks would diverge, and each would
re-fire the other's alerts.

```bat
set WSL=\\wsl.localhost\Ubuntu-24.04\home\bill\projects\equity-watch
copy "%WSL%\.env" .
copy "%WSL%\alerts.json" .
copy "%WSL%\revisits.json" .
copy "%WSL%\holdings.json" .
robocopy "%WSL%\.cache" .cache /E
robocopy "%WSL%\reports" reports /E

mkdir "%USERPROFILE%\.equity_watch"
copy "\\wsl.localhost\Ubuntu-24.04\home\bill\.equity_watch\schwab_tokens.json" "%USERPROFILE%\.equity_watch\"
```

- `analysis.config.json` is committed, so the clone already has it.
- `.cache\` would rebuild on its own, but `profiles\` (FMP's free-tier quota),
  `beta\`, and `bars\` cost API calls to refetch, so copy it.
- `reports\` is only old CSV output, so it's optional.
- There is no `history\` unless `analyze` has been run.

Then, in WSL, rename the old state so nothing writes to it by accident:

```sh
cd ~/projects/equity-watch && for f in alerts.json revisits.json holdings.json; do mv "$f" "$f.moved-to-windows"; done
```

### 3. Smoke test

```bat
node dist\cli.js alert list
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-and-publish.ps1
type logs\check-*.log
```

Outside market hours, the check logs `Skipped: market closed …` and exits 0.
That's success.

### 4. Register the task

In an **elevated PowerShell** ("Run as administrator"). The task still runs as
your own user; registering an S4U task is what needs admin:

```powershell
$repo = "$env:USERPROFILE\projects\equity-watch"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$repo\scripts\check-and-publish.ps1`"" `
  -WorkingDirectory $repo

# Weekdays 01:55-18:15 Mountain, every 15 minutes: covers 04:00-20:00 Eastern.
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 1:55AM
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At 1:55AM `
  -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Hours 16 -Minutes 20)).Repetition

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# S4U = "Run whether user is logged on or not" without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U

Register-ScheduledTask -TaskName "equity-watch check" -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description "Poll equity-watch alerts and publish watch.billbaran.us"
```

- **Regular hours only:** use `-At 7:25AM` and `-RepetitionDuration (New-TimeSpan -Hours 6 -Minutes 50)`.
- **Why S4U:** it runs in a background session with no desktop, so no console
  window opens every 15 minutes, and it keeps running while you're logged off.
  `-WindowStyle Hidden` is not a substitute: the window still flashes, because
  Windows opens it before PowerShell reads the flag. S4U has internet access and
  your user profile (tokens, `.env`), but no credentials for network shares.
  Verified 2026-09-14.
- **Without admin rights:** keep the default logon type and run the script
  through `conhost.exe --headless powershell.exe ...` instead. No window appears,
  but the task only runs while you're logged on.
- **An existing task** can be switched in place, also elevated:
  `Set-ScheduledTask -TaskName "equity-watch check" -Principal $principal`.

Verify:

```powershell
Start-ScheduledTask -TaskName "equity-watch check"
Get-ScheduledTaskInfo -TaskName "equity-watch check"   # LastTaskResult 0 = success
```

### 5. Optional: dead-man's switch

Add `HEALTHCHECK_URL=https://hc-ping.com/<uuid>` to `.env` (see "Known
weakness" above).

---

## Day to day

- **Weekly Schwab login:** the refresh token lasts 7 days. Run
  `node dist\cli.js schwab-login` in cmd. When it lapses, checks fail and the log says so.
- **After pulling code:** `git pull`, `npm ci`, `npm run build`. The script
  builds only when `dist\` is missing, not on every run.
- **Dashboard edits:** each run starts with `ops pull`, which applies alert
  changes queued from the page. It needs `OPS_QUEUE_URL` in `.env` (stack output
  `OpsQueueUrl`, with `EnableOps=true`). Without it, the step logs "Ops disabled".
  A failed pull doesn't stop the check, and its ops stay queued.
- **Logs:** `logs\check-YYYY-MM-DD.log`, kept 14 days. Task Scheduler's History
  tab shows each run's result code.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Last result `0x1`, log shows a Schwab auth error | Refresh token expired. Run `schwab-login`. |
| `node is not on PATH` in the log | The task's account can't find Node. Reinstall with "Add to PATH", or put the full path in the script. |
| No log file at all | The task didn't start: PC off, or `-ExecutionPolicy Bypass` missing from the action. Check Task Scheduler History. |
| Runs, but dashboard never updates | `--skip-unchanged` saw nothing new; it republishes at least every 30 minutes. Check `S3_BUCKET` and AWS keys in `.env`. |
| Alerts firing twice, or state flip-flopping | The WSL checkout is still running checks too. See step 2. |
| Task succeeds, but the log shows `==> alert check` with no output under it | The build predates the Windows entry-point fix (2026-09-13), so the CLI exits 0 without doing anything. Run `git pull`, then `npm run build`. |
