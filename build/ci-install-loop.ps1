# Runs a Windows installer again and again, each time as a first install, and counts the runs
# that fail. Installers built with electron-builder before 26.12 crashed now and then on a first
# install (0xC0000005 in the installer's System.dll, electron-builder#9769): only when no earlier
# install is recorded does the installer ask Windows for the per-user Programs folder, the step
# that crashed. So before every run the installed app and its registry entries are removed.
#
#   pwsh build/ci-install-loop.ps1 -Installer <setup.exe> [-Runs 25] [-Label name] [-ExpectClean]
#
# -ExpectClean fails the script when a run doesn't install. Without it (a baseline release, the
# control that shows this check can catch the crash) it only reports.
param(
  [Parameter(Mandatory = $true)] [string] $Installer,
  [int] $Runs = 25,
  [string] $Label = '',
  [switch] $ExpectClean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$name = Split-Path -Leaf $Installer
if (-not $Label) { $Label = $name }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\scalemax-ide'
$appExe = Join-Path $installDir 'ScaleMax IDE.exe'
$crashCode = -1073741819 # 0xC0000005, an access violation

# What an install leaves in the registry: HKCU\Software\{APP_GUID} with InstallLocation, and its
# entry under Uninstall. Found by their values, so the GUID needn't be known here.
function Get-InstallKeys {
  foreach ($key in Get-ChildItem -Path 'HKCU:\Software' -ErrorAction SilentlyContinue) {
    $value = Get-ItemProperty -LiteralPath $key.PSPath -Name 'InstallLocation' -ErrorAction SilentlyContinue
    if ($value -and "$($value.InstallLocation)" -like '*scalemax-ide*') { $key.PSPath }
  }
  foreach ($key in Get-ChildItem -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue) {
    $value = Get-ItemProperty -LiteralPath $key.PSPath -Name 'DisplayName' -ErrorAction SilentlyContinue
    if ($value -and "$($value.DisplayName)" -eq 'ScaleMax IDE') { $key.PSPath }
  }
}

function Clear-Install {
  Get-Process -Name 'ScaleMax IDE' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($key in @(Get-InstallKeys)) { Remove-Item -LiteralPath $key -Recurse -Force }
  for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $installDir); $i++) {
    try { Remove-Item -LiteralPath $installDir -Recurse -Force } catch { Start-Sleep -Seconds 1 }
  }
  if ((Test-Path -LiteralPath $installDir) -or @(Get-InstallKeys).Count) {
    throw 'Could not remove the earlier install before a run'
  }
}

$counts = [ordered]@{ 'installed' = 0; 'crashed' = 0; 'failed' = 0; 'not installed' = 0 }
$crashShown = $false
for ($run = 1; $run -le $Runs; $run++) {
  Clear-Install
  $started = Get-Date
  $code = (Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru).ExitCode
  $result = if ($code -eq $crashCode) { 'crashed' } elseif ($code -ne 0) { 'failed' } else { 'not installed' }
  if ($code -eq 0) {
    # The one-click installer can hand the copying to a child process: wait for the app.
    for ($i = 0; $i -lt 60 -and -not (Test-Path -LiteralPath $appExe); $i++) { Start-Sleep -Seconds 1 }
    if (Test-Path -LiteralPath $appExe) { $result = 'installed' }
  }
  $counts[$result]++
  Write-Host ('[install-loop] {0}, run {1}/{2}: {3} (exit {4}, {5:N1} s)' -f $Label, $run, $Runs, $result, $code, ((Get-Date) - $started).TotalSeconds)

  if ($result -eq 'crashed' -and -not $crashShown) {
    # The first crash only: what Windows logged about it (the faulting module and offset).
    $crashShown = $true
    Start-Sleep -Seconds 2
    try {
      $entries = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000; StartTime = $started } -ErrorAction Stop |
        Where-Object { $_.Message -like "*$name*" })
    } catch {
      $entries = @() # none logged
    }
    if ($entries.Count) {
      foreach ($entry in $entries) { Write-Host "$($entry.TimeCreated) $($entry.Message)" }
    } else {
      Write-Host '[install-loop] Windows logged no Application Error event for this crash'
    }
  }
}
Clear-Install

$other = $counts['failed'] + $counts['not installed']
$summary = '[install-loop] {0}: {1} runs, {2} installed, {3} crashed (0xC0000005), {4} other failures' -f $Label, $Runs, $counts['installed'], $counts['crashed'], $other
Write-Host $summary
if ($env:GITHUB_STEP_SUMMARY) {
  Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value @(
    "### Fresh installs: $Label", '',
    '| Runs | Installed | Crashed (0xC0000005) | Other failures |', '|---|---|---|---|',
    "| $Runs | $($counts['installed']) | $($counts['crashed']) | $other |", '')
}
if ($ExpectClean -and $counts['installed'] -ne $Runs) {
  Write-Host "::error::$summary"
  exit 1
}
Write-Host "::notice::$summary"
exit 0
