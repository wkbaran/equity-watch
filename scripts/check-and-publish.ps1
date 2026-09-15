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
  - If HEALTHCHECK_URL is set in .env, pings it on success and <url>/fail on
    failure, so a dead-man's-switch service notices when runs stop.
  - `alert check` exits immediately outside market sessions without fetching
    quotes, so a broad schedule costs nothing when the market is closed.

  Exits 0 on success, or with the first failing step's exit code.
#>
[CmdletBinding()]
param()

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

$code = Invoke-Logged "alert check" "node" @($cli, "alert", "check")
if ($code -ne 0) {
    Stop-Run $code
}

$code = Invoke-Logged "dashboard publish" "node" @($cli, "dashboard", "--site", "site", "--publish", "--skip-unchanged", "--quiet")
Stop-Run $code
