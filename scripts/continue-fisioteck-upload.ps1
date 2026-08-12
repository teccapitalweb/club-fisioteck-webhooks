param(
  [Parameter(Mandatory = $true)]
  [int]$InitialProcessId
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectDirectory 'migration-output'
$reconcileOutput = Join-Path $outputDirectory 'bunny-reconcile.stdout.log'
$reconcileError = Join-Path $outputDirectory 'bunny-reconcile.stderr.log'
$verifyOutput = Join-Path $outputDirectory 'bunny-verify.stdout.log'
$verifyError = Join-Path $outputDirectory 'bunny-verify.stderr.log'
$node = (Get-Command node).Source

Wait-Process -Id $InitialProcessId -ErrorAction SilentlyContinue

$attempt = 0
do {
  $attempt += 1
  $reconcile = Start-Process `
    -FilePath $node `
    -ArgumentList @('scripts\upload-fisioteck-bunny.js', '--upload') `
    -WorkingDirectory $projectDirectory `
    -RedirectStandardOutput $reconcileOutput `
    -RedirectStandardError $reconcileError `
    -WindowStyle Hidden `
    -Wait `
    -PassThru

  if ($reconcile.ExitCode -ne 0 -and $attempt -lt 20) {
    Start-Sleep -Seconds ([Math]::Min(300, 30 * $attempt))
  }
} while ($reconcile.ExitCode -ne 0 -and $attempt -lt 20)

if ($reconcile.ExitCode -ne 0) { exit $reconcile.ExitCode }

$verify = Start-Process `
  -FilePath $node `
  -ArgumentList @('scripts\upload-fisioteck-bunny.js', '--verify') `
  -WorkingDirectory $projectDirectory `
  -RedirectStandardOutput $verifyOutput `
  -RedirectStandardError $verifyError `
  -WindowStyle Hidden `
  -Wait `
  -PassThru

exit $verify.ExitCode
