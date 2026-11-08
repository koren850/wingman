# Checks a built Windows app. Used by ci.yml (packaging smoke job) and release.yml (before the installer is attached to a release).
#   -Unpacked  app/dist/win-unpacked (the app folder electron-builder made)
#   -Installer app/dist/Wingman-Setup-<version>-x64.exe
# Steps: 1 the Electron fuses are off in the exe; 2 `Wingman.exe --wingman-smoke` on the unpacked app; 3 silent per-user install (no admin),
# the Start menu shortcut, `--wingman-smoke` on the installed app; 4 the tray app starts and stays up for 15 seconds (soft: a warning, not a failure);
# 5 silent uninstall removes the program folder. Nothing here needs a network, a microphone or an API key.
param(
  [Parameter(Mandatory = $true)][string]$Unpacked,
  [Parameter(Mandatory = $true)][string]$Installer
)
$ErrorActionPreference = "Stop"
$Unpacked = (Resolve-Path $Unpacked).Path
$Installer = (Resolve-Path $Installer).Path
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$failures = @()
function Fail($m) { Write-Host "FAIL: $m"; $script:failures += $m }

function Invoke-Smoke($exe, $label) {
  $out = Join-Path $temp ("smoke-" + [guid]::NewGuid().ToString("N") + ".txt")
  $env:WINGMAN_SMOKE_OUT = $out
  $p = Start-Process -FilePath $exe -ArgumentList "--wingman-smoke" -PassThru -NoNewWindow
  if (-not $p.WaitForExit(180000)) { $p.Kill(); Fail "$label : --wingman-smoke did not finish in 3 minutes"; return }
  Remove-Item Env:WINGMAN_SMOKE_OUT
  $text = if (Test-Path $out) { Get-Content $out -Raw } else { "" }
  Write-Host "$label : exit code $($p.ExitCode); report: $text"
  if ($p.ExitCode -ne 0 -or $text -notmatch '"ok":true') { Fail "$label : smoke check failed" }
}

# 1. Fuses (RunAsNode, NODE_OPTIONS and --inspect must be off).
Push-Location (Join-Path $PSScriptRoot "..\..\app")
node scripts/set-fuses.cjs $Unpacked --check
if ($LASTEXITCODE -ne 0) { Fail "the Electron fuses are not off in Wingman.exe" }
Pop-Location

# 2. The unpacked app.
Invoke-Smoke (Join-Path $Unpacked "Wingman.exe") "unpacked"

# 3. Install for the current user, silently.
$program = Join-Path $env:LOCALAPPDATA "Programs\Wingman"
$p = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru -Wait
if ($p.ExitCode -ne 0) { Fail "the installer exited with code $($p.ExitCode)" }
$exe = Join-Path $program "Wingman.exe"
if (-not (Test-Path $exe)) { Fail "Wingman.exe is not in $program after a silent install"; }
else {
  $lnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Wingman.lnk"
  if (-not (Test-Path $lnk)) { Fail "no Start menu shortcut at $lnk" }
  Invoke-Smoke $exe "installed"

  # 4. The tray app starts and stays up (soft check).
  $data = Join-Path $temp "wingman-tray-data"
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  $env:WINGMAN_DATA_DIR = $data
  $tray = Start-Process -FilePath $exe -PassThru
  Start-Sleep -Seconds 15
  if ($tray.HasExited) { Write-Host "::warning::the tray app exited within 15 seconds (exit code $($tray.ExitCode)); see $data"; if (Test-Path "$data\calls\tray.log") { Get-Content "$data\calls\tray.log" -Tail 30 } }
  else { Write-Host "the tray app is running after 15 seconds"; Stop-Process -Id $tray.Id -Force; Get-Process -Name "Wingman" -ErrorAction SilentlyContinue | Stop-Process -Force }
  Remove-Item Env:WINGMAN_DATA_DIR

  # 5. Uninstall.
  $un = Join-Path $program "Uninstall Wingman.exe"
  if (-not (Test-Path $un)) { Fail "no uninstaller at $un" }
  else {
    Start-Process -FilePath $un -ArgumentList "/S" -Wait
    for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
    if (Test-Path $exe) { Fail "Wingman.exe is still there 60 seconds after the silent uninstall" }
  }
}

if ($failures.Count -gt 0) { Write-Host "`n$($failures.Count) problem(s):"; $failures | ForEach-Object { Write-Host " - $_" }; exit 1 }
Write-Host "Windows packaging smoke: all checks passed."
