<#
.SYNOPSIS
  Poll equity-watch alerts, then publish the browser dashboard if anything changed.

.DESCRIPTION
  Windows-native counterpart to scripts/check-and-publish.sh, meant for Task
  Scheduler. SCHEDULING.md covers setup, including registering the task.

  - Runs from the repository root, whatever directory Task Scheduler starts in.
  - Appends to logs\check-YYYY-MM-DD.log (local date); deletes logs older than
    14 days.
  - Builds dist\ first only if it's missing. After pulling new code, run
    `npm ci` and `npm run build` yourself.
  - Tells the dashboard when the next run is due, read from this task's own
    registration, so the published page can say "applies at the next check,
    1:55 AM" instead of guessing. Task Scheduler's NextRunTime already accounts
    for both the repetition interval and the daily window.
  - If HEALTHCHECK_URL is set in .env, pings it on success and <url>/fail on
    failure, so a dead-man's-switch service notices when runs stop.
  - `alert check` exits immediately outside market sessions without fetching
    quotes, so a broad schedule costs nothing when the market is closed.

  Exits 0 on success, or with the first failing step's exit code.
#>
[CmdletBinding()]
param(
    # The registered task to read NextRunTime from. Only used for what the page
    # displays; a wrong or missing name costs nothing but that line.
    [string]$TaskName = "equity-watch check"
)

$ErrorActionPreference = "Continue"
$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectDir

$LogDir = Join-Path $ProjectDir "logs"
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}
$LogFile = Join-Path $LogDir ("check-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

function Write-Log {
    param([string]$Message)
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"), $Message
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    # Write-Host, not Write-Output: output would leak into function return values.
    Write-Host $line
}

function Get-EnvValue {
    param([string]$Name)
    $envFile = Join-Path $ProjectDir ".env"
    if (-not (Test-Path -LiteralPath $envFile)) {
        return $null
    }
    foreach ($raw in Get-Content -LiteralPath $envFile) {
        if ($raw -match "^\s*$Name\s*=\s*(.*?)\s*$") {
            return $Matches[1].Trim('"', "'")
        }
    }
    return $null
}

function Send-Healthcheck {
    param([bool]$Succeeded)
    $url = Get-EnvValue "HEALTHCHECK_URL"
    if (-not $url) {
        return
    }
    $target = if ($Succeeded) { $url } else { "$($url.TrimEnd('/'))/fail" }
    try {
        Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 10 | Out-Null
    } catch {
        Write-Log "Healthcheck ping failed: $($_.Exception.Message)"
    }
}

# The scheduler is the only thing that knows when the next run is, so ask it
# rather than inferring. Returns $null when the task can't be read (a manual run
# on another machine, a renamed task); the page then falls back to the cadence
# `ops pull` has measured for itself.
function Get-NextCheckTime {
    try {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    } catch {
        Write-Log "No scheduled task '$TaskName' to read NextRunTime from; the page will estimate instead."
        return $null
    }
    $next = $info.NextRunTime
    # A disabled or one-shot task reports no next run.
    if ($null -eq $next) {
        return $null
    }
    return $next.ToUniversalTime().ToString("o")
}

function Invoke-Logged {
    param([string]$Name, [string]$Command, [string[]]$Arguments)
    Write-Log "==> $Name"
    $output = & $Command @Arguments 2>&1
    $code = $LASTEXITCODE
    foreach ($item in $output) {
        Write-Log ("    " + $item.ToString())
    }
    if ($code -ne 0) {
        Write-Log "$Name failed with exit code $code."
    }
    return $code
}

function Stop-Run {
    param([int]$Code)
    Send-Healthcheck ($Code -eq 0)
    Write-Log ("=== done (exit {0}) ===" -f $Code)
    exit $Code
}

Get-ChildItem -LiteralPath $LogDir -Filter "check-*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

Write-Log "=== equity-watch check ==="

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Log "node is not on PATH for this account. Install Node.js, or add it to the task user's PATH."
    Stop-Run 1
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "dist\cli.js"))) {
    Write-Log "dist\cli.js is missing; building first."
    $code = Invoke-Logged "npm run build" "npm" @("run", "build")
    if ($code -ne 0) {
        Stop-Run $code
    }
}

$cli = Join-Path $ProjectDir "dist\cli.js"

# Apply alert changes queued from the dashboard first, so the check evaluates
# them. A failure is logged but doesn't stop the check; failed ops stay queued.
# Without OPS_QUEUE_URL in .env this prints "Ops disabled" and exits 0.
$code = Invoke-Logged "ops pull" "node" @($cli, "ops", "pull")
if ($code -ne 0) {
    Write-Log "Continuing with the check anyway."
}

# Give any position that has no alert a starting one, so a lot added from the
# dashboard, an import, or the CLI is all handled the same way. It costs nothing
# when every position is already covered: it exits before fetching any quote.
$code = Invoke-Logged "holdings cover" "node" @($cli, "holdings", "cover")
if ($code -ne 0) {
    Write-Log "Continuing with the check anyway."
}

$code = Invoke-Logged "alert check" "node" @($cli, "alert", "check")
if ($code -ne 0) {
    Stop-Run $code
}

$publishArgs = @($cli, "dashboard", "--site", "site", "--publish", "--skip-unchanged", "--quiet")
$nextCheck = Get-NextCheckTime
if ($nextCheck) {
    $publishArgs += @("--next-check", $nextCheck)
}
$code = Invoke-Logged "dashboard publish" "node" $publishArgs
Stop-Run $code
