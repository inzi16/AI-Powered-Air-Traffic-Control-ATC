# Release readiness

Smart Air Traffic Control (ATC) can run as a production-configured local container stack without publishing it to an external host. The same images can later be moved to a stateful container platform that supports long-lived WebSocket connections.

## Validate everything

```powershell
.\scripts\doctor.ps1 -CheckOllama
.\scripts\verify.ps1
```

The doctor checks local prerequisites without changing the machine. Verification compiles and tests the backend, lints and builds the frontend, and validates the merged release Compose configuration. Add `-RequireDocker` to the doctor when validating the container workflow.

## Start the release-configured stack

```powershell
.\scripts\start-release.ps1 -Build
```

The launcher creates an in-memory 256-bit service credential for the current process, starts both containers, waits for the proxy health check, and prints the local URL. It does not write the credential to disk.

To provide an explicit key and hostname list:

```powershell
.\scripts\start-release.ps1 -Build `
  -ApiKey 'replace-with-a-secure-random-value' `
  -AllowedHosts 'localhost,127.0.0.1'
```

Open `http://127.0.0.1:8080`. Browser traffic remains same-origin; Nginx authenticates its private upstream requests to FastAPI and upgrades the telemetry WebSocket.

The backend image includes the optional speech packages. The first speech-to-text request downloads the configured faster-whisper model into the persistent `atc_model_cache` Docker volume; later container restarts reuse it. Edge TTS and an external Ollama endpoint still require network reachability. If those services are unavailable, the deterministic flight, clearance, emergency, map, radar, and text fallback paths continue to work.

Stop the stack with:

```powershell
.\scripts\stop-release.ps1
```

## Before an external deployment

- Choose a container host that supports a continuously running Python service and WebSockets.
- Put TLS and OIDC authentication in front of Nginx; the service API key is not a user-authentication system.
- Configure the real public hostname in `ATC_ALLOWED_HOSTS` and the origin in `ATC_ALLOWED_ORIGINS`.
- Use managed secrets, image scanning, backups, monitoring, and a licensed map/aviation-data policy.
- Add persistent PostgreSQL/PostGIS storage before promising durable multi-user sessions or replay retention across restarts.
- Run load, failover, accessibility, and recovery tests against the exact release images.

The current application remains a training and portfolio system, not operational ATC software.
