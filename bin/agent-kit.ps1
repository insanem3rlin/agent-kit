# Windows entry point for bin/agent-kit: finds a Python 3.10+ that is not the
# Microsoft Store stub and runs agent-kit with it.
# Usage: agent-kit.ps1 <install|sync|doctor|uninstall> [options]
# No $ErrorActionPreference = 'Stop': under Windows PowerShell 5.1 it turns any
# stderr line of a native command into a terminating error. Exit codes are checked.

# A venv interpreter is refused: its path ends up in settings.json and the
# scheduled task, and both would break when the venv is deleted.
function Test-Python([string]$exe, [string[]]$pre = @()) {
    try {
        $out = & $exe @pre -c "import sys; print(sys.executable if sys.version_info >= (3, 10) and sys.prefix == sys.base_prefix else '')" 2>$null
    } catch { return $null }
    if ($LASTEXITCODE -eq 0 -and "$out".Trim()) { return "$out".Trim() }
    return $null
}

$py = $null
if ($env:AGENT_KIT_PYTHON) { $py = Test-Python $env:AGENT_KIT_PYTHON }
if (-not $py -and (Get-Command py -ErrorAction SilentlyContinue)) { $py = Test-Python 'py' @('-3') }
if (-not $py) {
    $found = Get-Command python, python3 -All -CommandType Application -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notlike '*\WindowsApps\*' }
    foreach ($c in $found) { $py = Test-Python $c.Source; if ($py) { break } }
}
if (-not $py -and (Get-Command uv -ErrorAction SilentlyContinue)) {
    $p = & uv python find '>=3.10' 2>$null
    if ($LASTEXITCODE -eq 0 -and $p) { $py = Test-Python "$p".Trim() }
}
if (-not $py) {
    Write-Host "agent-kit: no Python 3.10+ found (the Microsoft Store 'python3' stub does not count)."
    Write-Host "Install one ('uv python install', or 'winget install Python.Python.3.13') or set AGENT_KIT_PYTHON."
    exit 1
}

if ($args.Count -gt 0 -and $args[0] -in 'install', 'sync') {
    # Skills are linked as symbolic links, which Windows allows only with
    # Developer Mode on or from an elevated shell.
    & $py -c "import os, tempfile; d = tempfile.mkdtemp(); os.symlink(d, d + '-link', True); os.rmdir(d + '-link'); os.rmdir(d)" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "agent-kit: this account cannot create symbolic links."
        Write-Host "Turn on Developer Mode (Settings > System > For developers) or run from an elevated shell."
        exit 1
    }
}

& $py (Join-Path $PSScriptRoot 'agent-kit') @args
exit $LASTEXITCODE
