# ApplyDesk setup for Windows. Run in PowerShell (no admin needed):
#   irm https://raw.githubusercontent.com/bilie-tech/bilie-skills/main/scripts/bootstrap.ps1 | iex
#
# Installs what is missing (Node.js, Git, Claude Code), adds the bilie-skills
# marketplace, installs the applydesk plugin, then runs its health check.
$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $local = Join-Path $env:USERPROFILE '.local\bin'
  if (Test-Path $local) { $env:Path = "$local;$env:Path" }
}
function WingetInstall($id) {
  if (-not (Have winget)) { throw "winget is not available. Install '$id' by hand, then run this again." }
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
  RefreshPath
}

Step 'Node.js (20 or newer)'
$nodeOk = $false
if (Have node) { $nodeOk = ([int]((node --version).TrimStart('v').Split('.')[0])) -ge 20 }
if (-not $nodeOk) { WingetInstall 'OpenJS.NodeJS.LTS' }
node --version

Step 'Git'
if (-not (Have git)) { WingetInstall 'Git.Git' }
git --version

Step 'Browser'
$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) }
if (-not $browsers) { WingetInstall 'Google.Chrome' } else { Write-Host "Found $($browsers[0])" }

Step 'Claude Code'
if (-not (Have claude)) {
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  RefreshPath
}
claude --version

Step 'ApplyDesk plugin'
claude plugin marketplace add bilie-tech/bilie-skills
if ($LASTEXITCODE -ne 0) { claude plugin marketplace update bilie-skills }
claude plugin install applydesk@bilie-skills
if ($LASTEXITCODE -ne 0) { throw 'Plugin install failed (see above).' }

Step 'Health check (installs packages on first run)'
$cli = Get-ChildItem -Path (Join-Path $env:USERPROFILE '.claude\plugins') -Recurse -Filter applydesk.mjs -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '[\\/]skills[\\/]applydesk[\\/]scripts[\\/]' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $cli) { throw 'Could not find the installed applydesk.mjs under ~/.claude/plugins.' }
node $cli.FullName doctor --fix

Write-Host "`nDone. Open a new terminal, run 'claude', and say: set up ApplyDesk on this machine." -ForegroundColor Green
Write-Host "ApplyDesk data lives in $env:USERPROFILE\ApplyDesk"
