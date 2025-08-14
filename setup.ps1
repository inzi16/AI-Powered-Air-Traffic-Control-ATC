[CmdletBinding()]
param(
    [switch]$SkipAI,
    [switch]$SkipSimConnect,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendRoot = Join-Path $projectRoot 'backend'
$frontendRoot = Join-Path $projectRoot 'frontend'
$venvRoot = Join-Path $projectRoot '.venv'

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

Write-Host 'SkyCommand local setup' -ForegroundColor Green
Write-Host 'Simulation and training use only.' -ForegroundColor DarkYellow

Write-Step 'Checking prerequisites'
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python 3.11+ is required. Install it and rerun this script.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 22+ is required. Install it and rerun this script.'
}

Write-Step 'Creating an isolated Python environment'
if (-not (Test-Path -LiteralPath $venvRoot)) {
    & python -m venv $venvRoot
}
$pythonExe = Join-Path $venvRoot 'Scripts\python.exe'
& $pythonExe -m pip install --upgrade pip
& $pythonExe -m pip install -r (Join-Path $backendRoot 'requirements-core.txt')
if (-not $SkipAI) {
    & $pythonExe -m pip install -r (Join-Path $backendRoot 'requirements-ai.txt')
}
if (-not $SkipSimConnect) {
    & $pythonExe -m pip install -r (Join-Path $backendRoot 'requirements-simconnect.txt')
}

Write-Step 'Installing locked frontend dependencies'
Push-Location $frontendRoot
try {
    if (Test-Path -LiteralPath (Join-Path $frontendRoot 'package-lock.json')) {
        & npm ci
    } else {
        & npm install
    }
    & npm run build
} finally {
    Pop-Location
}

if ($NoLaunch) {
    Write-Host "`nSetup and production build completed." -ForegroundColor Green
    exit 0
}

Write-Step 'Launching the development stack'
$backendCommand = "Set-Location -LiteralPath '$projectRoot'; & '$pythonExe' -m uvicorn backend.main:app --host 127.0.0.1 --port 8000"
$frontendCommand = "Set-Location -LiteralPath '$frontendRoot'; npm run dev"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $backendCommand
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList '-NoExit', '-Command', $frontendCommand
Start-Sleep -Seconds 2
Start-Process 'http://127.0.0.1:5173'

Write-Host "`nSkyCommand: http://127.0.0.1:5173" -ForegroundColor Green
Write-Host 'API docs:  http://127.0.0.1:8000/docs' -ForegroundColor Green
Write-Host 'Use Ctrl+C in each server window to stop.' -ForegroundColor DarkGray
