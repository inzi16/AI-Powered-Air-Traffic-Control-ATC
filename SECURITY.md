# Security policy

Smart Air Traffic Control (ATC) is a training and simulation project. It is not certified for operational air-traffic control, dispatch, navigation, or emergency decision-making.

## Supported versions

Security fixes are applied to the latest revision on the default branch. Pre-release snapshots and older revisions are not supported separately.

## Reporting a vulnerability

Use the repository's **Security** tab to submit a private vulnerability report when private vulnerability reporting is enabled. If that option is unavailable, contact the repository owner privately through their GitHub profile. Do not open a public issue for an unpatched vulnerability.

Include the affected revision, reproduction steps, impact, attack prerequisites, and any suggested mitigation. Do not include live credentials, personal information, or real operational aviation data. A maintainer will acknowledge the report, validate it, and coordinate disclosure; no fixed response SLA is currently promised.

## Credentials and sensitive data

- Never commit populated `.env` files, private keys, access tokens, simulator credentials, production exports, or raw user recordings. The committed env files are examples only.
- Keep `ATC_API_KEY` empty in templates. Generate a unique value with at least 32 random bytes for each deployment and rotate it immediately if exposure is suspected.
- Treat the API key as a coarse service credential, not user identity. Training-session IDs are selectors and are not authentication or authorization tokens.
- Never place service credentials in `VITE_*` variables, frontend source, URLs, command arguments, screenshots, benchmark metadata, logs, or support bundles.
- Keep Ollama and simulator adapters on trusted private interfaces. They are not hardened public authentication boundaries.
- If a secret reaches Git history, revoke or rotate it first. Removing it from the latest commit is insufficient; coordinate any history rewrite with all repository users.

## Deployment baseline

- Set `ATC_ENV=production`, keep developer state injection and SimConnect disabled unless explicitly required, and use exact HTTPS origins and deployed hostnames.
- Put the service behind a trusted TLS-terminating gateway with user authentication, authorization, rate limits, request-size limits, and security logging. Do not expose the backend or model service directly to the internet.
- Keep secrets in the deployment platform's secret store. Confirm `.dockerignore` excludes all populated env files, credentials, local runtimes, logs, and private build artifacts before using a remote builder.
- Treat simulator, voice, model, weather, map, import, and WebSocket data as untrusted inputs with explicit size, type, timeout, freshness, and concurrency limits.
- Restrict access to journal exports and recordings; establish retention and deletion rules before collecting data from other users.

## Release checklist

- Run `scripts/verify.ps1` and review `git status --short` plus the staged diff before release.
- Run a repository and reachable-history secret scan with GitHub secret scanning, Gitleaks, or an equivalent maintained scanner. Enable push protection where available.
- Review Dependabot updates, run dependency and container vulnerability scans, pin trusted release actions, and produce an SBOM for distributed images.
- Verify that production startup fails with an empty key, host/origin allowlists match the deployment, developer endpoints are disabled, and no real secrets are present in image layers or build context.
- Keep backups and audit exports encrypted, access-controlled, integrity-checked, and tested for restoration.
