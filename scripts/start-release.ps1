[CmdletBinding()]
param(
    [string]$ApiKey,
    [string]$AllowedHosts = 'localhost,127.0.0.1',
    [switch]$Build
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $ApiKey) {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $ApiKey = [Convert]::ToHexString($bytes).ToLowerInvariant()
}

$env:ATC_API_KEY = $ApiKey
$env:ATC_ALLOWED_HOSTS = $AllowedHosts
if (-not $env:ATC_ALLOWED_ORIGINS) { $env:ATC_ALLOWED_ORIGINS = 'http://localhost:8080' }

$composeArguments = @(
    'compose',
    '-f', (Join-Path $projectRoot 'docker-compose.yml'),
    '-f', (Join-Path $projectRoot 'docker-compose.release.yml'),
    'up', '-d'
)
if ($Build) { $composeArguments += '--build' }

Push-Location $projectRoot
try {
    & docker @composeArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed with exit code $LASTEXITCODE." }

    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        Start-Sleep -Seconds 2
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/healthz' -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                Write-Host 'SMART ATC release stack is ready at http://127.0.0.1:8080' -ForegroundColor Green
                exit 0
            }
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Release stack did not become healthy within 90 seconds.' }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
} finally {
    Pop-Location
}
