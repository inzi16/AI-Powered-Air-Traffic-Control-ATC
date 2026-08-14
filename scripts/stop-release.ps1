[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# Compose resolves required release variables even for `down`. These values are
# interpolation-only placeholders; no containers are created by this command.
if (-not $env:ATC_API_KEY) { $env:ATC_API_KEY = 'stop-only-placeholder' }
if (-not $env:ATC_ALLOWED_HOSTS) { $env:ATC_ALLOWED_HOSTS = 'localhost,127.0.0.1' }

Push-Location $projectRoot
try {
    & docker compose -f docker-compose.yml -f docker-compose.release.yml down
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}
