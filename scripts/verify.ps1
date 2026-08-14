[CmdletBinding()]
param(
    [switch]$SkipBackend,
    [switch]$SkipFrontend,
    [switch]$SkipContainers
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$frontendRoot = Join-Path $projectRoot 'frontend'
$venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
$pythonCommand = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { 'python' }

function Invoke-Checked([string]$Label, [scriptblock]$Action) {
    Write-Host "`n==> $Label" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

Push-Location $projectRoot
try {
    if (-not $SkipBackend) {
        $previousPythonPath = $env:PYTHONPATH
        try {
            $env:PYTHONPATH = Join-Path $projectRoot 'backend'
            Invoke-Checked 'Compiling backend' { & $pythonCommand -m compileall -q backend }
            Invoke-Checked 'Verifying committed API contracts' { & $pythonCommand scripts\generate_contracts.py --check }
            Invoke-Checked 'Running backend tests' { & $pythonCommand -m pytest -q backend\tests }
            Invoke-Checked 'Running deterministic benchmark gate' { & $pythonCommand scripts\benchmark_backend.py --quick --check }
        } finally {
            $env:PYTHONPATH = $previousPythonPath
        }
    }

    if (-not $SkipFrontend) {
        Push-Location $frontendRoot
        try {
            Invoke-Checked 'Linting frontend' { & npm run lint }
            Invoke-Checked 'Building frontend' { & npm run build }
        } finally {
            Pop-Location
        }
    }

    if (-not $SkipContainers) {
        if (Get-Command docker -ErrorAction SilentlyContinue) {
            if (-not $env:ATC_API_KEY) { $env:ATC_API_KEY = 'local-verification-only' }
            if (-not $env:ATC_ALLOWED_HOSTS) { $env:ATC_ALLOWED_HOSTS = 'localhost,127.0.0.1' }
            Invoke-Checked 'Validating Docker Compose release configuration' {
                & docker compose -f docker-compose.yml -f docker-compose.release.yml config --quiet
            }
        } else {
            Write-Warning 'Docker is unavailable; container configuration validation was skipped.'
        }
    }
} finally {
    Pop-Location
}

Write-Host "`nSMART ATC verification passed." -ForegroundColor Green
