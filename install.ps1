# Bootstrap agent-kit on Windows: clone (if needed), then run `agent-kit install`.
# Usage: install.ps1 [--dry-run] [--adopt] [--no-timer]
# Exit codes are checked by hand; see bin\agent-kit.ps1 for why there is no 'Stop'.

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'agent-kit: git is required'
    exit 1
}

$kit = $env:AGENT_KIT_HOME
if (-not $kit -and (Test-Path (Join-Path $PSScriptRoot 'bin\agent-kit'))) { $kit = $PSScriptRoot }
if (-not $kit) { $kit = Join-Path $HOME '.agent-kit' }
if (-not (Test-Path $kit)) {
    $repo = $env:AGENT_KIT_REPO
    if (-not $repo) { $repo = 'https://github.com/insanem3rlin/agent-kit.git' }
    git clone $repo $kit
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$env:AGENT_KIT_HOME = $kit
& (Join-Path $kit 'bin\agent-kit.ps1') install @args
exit $LASTEXITCODE
