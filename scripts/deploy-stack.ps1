<#
Deploy infra/cloudformation.yaml, taking every parameter from .env.

This exists because `aws cloudformation deploy` is destructive when you forget an
argument. Every parameter in the template except BucketName defaults to empty or
false, so a bare deploy against a live stack turns EnableOps off - deleting the
Lambda, the SQS queue and the /api/* behaviour - blanks the ops token, and drops
the custom domain and its certificate. Nothing warns you.

So: put the values in .env once, run this, and they are passed every time.

  .\scripts\deploy-stack.ps1                        # values from .env
  .\scripts\deploy-stack.ps1 CustomDomain=x.com     # ...with one overridden
  .\scripts\deploy-stack.ps1 -DryRun                # print the plan, deploy nothing

Precedence per value: CLI argument > environment variable > .env. That is the same
order dotenv gives the Node CLI, which does not override an already-set variable.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Overrides = @()
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectDir ".env"
$Template = Join-Path $ProjectDir "infra/cloudformation.yaml"

# Write-Error would wrap every one of these in a stack trace under
# $ErrorActionPreference = "Stop", which buries the sentence that matters.
function Fail {
    param([string]$Message, [int]$Code = 1)
    [Console]::Error.WriteLine($Message)
    exit $Code
}

$Override = @{}
foreach ($arg in $Overrides) {
    if ($arg -notmatch "^([A-Za-z]+)=(.*)$") {
        Fail "Unrecognized argument: $arg (expected Key=Value, or -DryRun)" 2
    }
    $Override[$Matches[1]] = $Matches[2]
}

# One key out of .env. Same parser as check-and-publish.ps1's Get-EnvValue: read
# line by line rather than dot-sourcing, because .env holds an AWS secret key and
# the ops token, and neither should ever be executed.
function Get-EnvValue {
    param([string]$Name)
    if (-not (Test-Path -LiteralPath $EnvFile)) { return $null }
    foreach ($raw in Get-Content -LiteralPath $EnvFile) {
        if ($raw -match "^\s*$Name\s*=\s*(.*?)\s*$") {
            return $Matches[1].Trim('"', "'")
        }
    }
    return $null
}

function Resolve-Value {
    param([string]$Param, [string]$VarName, [string]$Fallback = "")
    if ($Override.ContainsKey($Param)) { return $Override[$Param] }
    $fromEnv = [Environment]::GetEnvironmentVariable($VarName)
    if ($fromEnv) { return $fromEnv }
    $fromFile = Get-EnvValue $VarName
    if ($fromFile) { return $fromFile }
    return $Fallback
}

$StackName = Resolve-Value "StackName" "STACK_NAME" "equity-watch-dashboard"
$Region = Resolve-Value "Region" "AWS_REGION" "us-east-1"

# Every parameter the template takes, so the deploy never depends on what the AWS
# CLI does with the ones you leave out.
$Params = [ordered]@{
    BucketName        = Resolve-Value "BucketName" "S3_BUCKET"
    EnableOps         = Resolve-Value "EnableOps" "ENABLE_OPS" "false"
    OpsToken          = Resolve-Value "OpsToken" "OPS_TOKEN"
    EnableBasicAuth   = Resolve-Value "EnableBasicAuth" "ENABLE_BASIC_AUTH" "false"
    BasicAuthUser     = Resolve-Value "BasicAuthUser" "BASIC_AUTH_USER"
    BasicAuthPassword = Resolve-Value "BasicAuthPassword" "BASIC_AUTH_PASSWORD"
    CustomDomain      = Resolve-Value "CustomDomain" "CUSTOM_DOMAIN"
    HostedZoneId      = Resolve-Value "HostedZoneId" "HOSTED_ZONE_ID"
}

if (-not $Params.BucketName) {
    Fail "BucketName is required. Set S3_BUCKET in .env, or pass BucketName=..." 2
}
if ($Params.CustomDomain -and -not $Params.HostedZoneId) {
    Fail "CustomDomain needs HostedZoneId (the PUBLIC Route 53 zone). Set HOSTED_ZONE_ID in .env." 2
}

# The guard this script is really for: refuse to blank a parameter the deployed
# stack currently has set. Without it, one missing .env line silently tears down
# ops or the custom domain, and the failure looks like the site breaking on its
# own some minutes later.
$existing = $null
try {
    $existing = aws cloudformation describe-stacks --region $Region --stack-name $StackName `
        --query 'Stacks[0].Parameters[].[ParameterKey,ParameterValue]' --output text
} catch {
    $existing = $null  # no such stack yet; this is the first deploy
}
if ($existing) {
    $clearing = @()
    foreach ($line in ($existing -split "`r?`n")) {
        $parts = $line -split "`t"
        if ($parts.Count -lt 1 -or -not $parts[0]) { continue }
        $key = $parts[0].Trim()
        $value = if ($parts.Count -gt 1) { $parts[1].Trim() } else { "" }
        # "****" is how a NoEcho parameter reads back, so its real value can never
        # be recovered from the stack - which is why it has to live in .env.
        if (-not $value -or $value -eq "false" -or $value -eq "****") { continue }
        if (-not $Params.Contains($key)) { continue }
        # Empty is the obvious clearing case. true -> false is the dangerous one
        # and is NOT empty, so an earlier version of this let it through:
        # EnableOps resolving to its default would have deleted the Lambda, the
        # queue and the /api/* behaviour on a stack that had them.
        if ((-not $Params[$key]) -or ($value -eq "true" -and $Params[$key] -eq "false")) {
            $clearing += $key
        }
    }
    if ($clearing.Count -gt 0) {
        [Console]::Error.WriteLine("Refusing to deploy: these are set on the live stack and this deploy would clear them:")
        $clearing | ForEach-Object { [Console]::Error.WriteLine("  $_") }
        Fail "Set them in .env (see .env.example), or pass Key=Value to deploy anyway."
    }
}

# Secrets are redacted in what we print, but note they are still visible in the
# process list while `aws` runs - true of any --parameter-overrides use.
Write-Host "Deploying $StackName to ${Region}:"
foreach ($key in $Params.Keys) {
    $shown = if ($key -in @("OpsToken", "BasicAuthPassword")) {
        if ($Params[$key]) { "(set)" } else { "(empty)" }
    } elseif ($Params[$key]) { $Params[$key] } else { "(empty)" }
    Write-Host ("  {0,-18} {1}" -f $key, $shown)
}

if ($DryRun) {
    Write-Host "(-DryRun: nothing was deployed)"
    exit 0
}

$overrideArgs = $Params.Keys | ForEach-Object { "$_=$($Params[$_])" }
aws cloudformation deploy `
    --region $Region `
    --stack-name $StackName `
    --template-file $Template `
    --capabilities CAPABILITY_NAMED_IAM `
    --parameter-overrides $overrideArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

aws cloudformation describe-stacks --region $Region --stack-name $StackName `
    --query 'Stacks[0].Outputs' --output table
