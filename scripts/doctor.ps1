[CmdletBinding()]
param(
    [switch]$RequireDocker,
    [switch]$CheckOllama
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$frontendRoot = Join-Path $projectRoot 'frontend'
$failures = [System.Collections.Generic.List[string]]::new()

function Write-Check([string]$Label, [bool]$Passed, [string]$Detail, [bool]$Required = $true) {
    if ($Passed) {
        Write-Host "[PASS] $Label" -ForegroundColor Green -NoNewline
    } elseif ($Required) {
        Write-Host "[FAIL] $Label" -ForegroundColor Red -NoNewline
        $failures.Add($Label)
    } else {
        Write-Host "[INFO] $Label" -ForegroundColor Yellow -NoNewline
    }
    Write-Host " - $Detail"
}

Write-Host 'Smart ATC local readiness doctor' -ForegroundColor Cyan

$venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
$pythonCommand = if (Test-Path -LiteralPath $venvPython) {
    $venvPython
} else {
    (Get-Command python -ErrorAction SilentlyContinue).Source
}

if ($pythonCommand) {
    $pythonVersion = (& $pythonCommand -c "import sys; print('.'.join(map(str, sys.version_info[:3])))").Trim()
    $pythonOk = $LASTEXITCODE -eq 0 -and ([version]$pythonVersion -ge [version]'3.11.0')
    Write-Check 'Python 3.11+' $pythonOk $pythonVersion
    if ($pythonOk) {
        & $pythonCommand -c 'import fastapi, httpx, pydantic, pytest, uvicorn'
        Write-Check 'Backend dependencies' ($LASTEXITCODE -eq 0) 'FastAPI, Pydantic, HTTPX, Uvicorn and Pytest import successfully.'
    }
} else {
    Write-Check 'Python 3.11+' $false 'Python was not found. Run setup.ps1 after installing Python.'
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $nodeVersionText = (& $nodeCommand.Source --version).TrimStart('v')
    $nodeOk = $LASTEXITCODE -eq 0 -and ([version]$nodeVersionText -ge [version]'22.0.0')
    Write-Check 'Node.js 22+' $nodeOk $nodeVersionText
} else {
    Write-Check 'Node.js 22+' $false 'Node.js was not found.'
}

$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
Write-Check 'npm' ([bool]$npmCommand) $(if ($npmCommand) { (& $npmCommand.Source --version).Trim() } else { 'npm was not found.' })
Write-Check 'Frontend dependencies' (Test-Path -LiteralPath (Join-Path $frontendRoot 'node_modules')) 'frontend/node_modules is present; run npm ci if this fails.'

$requiredFiles = @(
    'backend\main.py',
    'backend\requirements-core.txt',
    'frontend\package-lock.json',
    'docker-compose.yml',
    'docker-compose.release.yml',
    'deploy\nginx.conf.template'
)
$missingFiles = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $projectRoot $_)) })
Write-Check 'Release files' ($missingFiles.Count -eq 0) $(if ($missingFiles.Count) { "Missing: $($missingFiles -join ', ')" } else { 'Core source, lockfile, Compose and proxy files are present.' })

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
if ($dockerCommand) {
    $previousErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $dockerVersion = (& $dockerCommand.Source version --format '{{.Server.Version}}' 2>&1 | Select-Object -Last 1)
        $dockerExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorPreference
    }
    $dockerReady = $dockerExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($dockerVersion)
    Write-Check 'Docker engine' $dockerReady $(if ($dockerReady) { "Server $dockerVersion" } else { 'CLI is installed but Docker Desktop/engine is not running.' }) $RequireDocker
} else {
    Write-Check 'Docker engine' $false 'Docker is not installed; it is optional for direct local development.' $RequireDocker
}

if ($CheckOllama) {
    try {
        $ollama = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2
        $modelCount = @($ollama.models).Count
        Write-Check 'Ollama' $true "$modelCount local model(s) available." $false
    } catch {
        Write-Check 'Ollama' $false 'No local Ollama service detected; deterministic ATC fallback remains available.' $false
    }
}

if ($failures.Count) {
    Write-Host "`nReadiness failed: $($failures -join ', ')" -ForegroundColor Red
    exit 1
}

Write-Host "`nLocal prerequisites are ready." -ForegroundColor Green
