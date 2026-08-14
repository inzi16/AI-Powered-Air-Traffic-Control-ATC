# Contributing to Smart Air Traffic Control (ATC)

Thank you for improving Smart ATC. Contributions should strengthen a reproducible training and simulation platform; this repository is not certified for operational air-traffic control, navigation, dispatch, or emergency decision-making.

## Before starting

- Search the issue tracker and the roadmap documents for related work.
- Open a focused feature request before investing in a large UI, contract, architecture, aviation-data, or AI change.
- Report vulnerabilities privately using the instructions in [SECURITY.md](./SECURITY.md), never in a public issue.
- Do not commit credentials, personal information, proprietary datasets, or real operational aviation data.

Good first contributions are narrow, testable bug fixes; accessibility improvements; deterministic tests; documentation corrections; and performance work with reproducible measurements.

## Local setup

The supported one-command setup is PowerShell on Windows. Install Python 3.11+ and Node.js 22+, then run:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
.\setup.ps1 -NoLaunch -SkipAI -SkipSimConnect
```

This creates `.venv`, installs the core/backend test dependencies and locked frontend dependencies, and verifies a frontend production build. AI speech packages and SimConnect are optional for the deterministic demo and test suite.

For a manual setup on another platform, create and activate a virtual environment, then install and verify each workspace:

```bash
python -m venv .venv
# Activate .venv using your shell's platform-specific command.
python -m pip install -r backend/requirements-dev.txt
cd frontend
npm ci
npm run build
```

Run the API from the repository root with `python -m uvicorn backend.main:app --reload --port 8000`. Run `npm run dev` from `frontend/` in another terminal. Optional integrations should degrade cleanly when they are not installed or reachable.

## Make a focused change

- Keep pull requests small enough to review and revert independently.
- Preserve authoritative server state, training-room isolation, monotonic sequence/revision handling, and idempotent command semantics.
- Treat simulator, voice, map, weather, and model output as untrusted, potentially stale input.
- Do not invent AI confidence percentages or describe deterministic guidance as model reasoning.
- Use licensed, attributable data and dependencies. Document data provenance, freshness, caching, and failure behavior.
- Preserve keyboard access, visible focus, screen-reader semantics, reduced motion, responsive layouts, and non-color-only status cues.
- Avoid unrelated formatting, generated-file, lockfile, or dependency churn.

## Contracts and generated files

REST, WebSocket, snapshot, and command changes must remain synchronized across backend schemas, OpenAPI, the contract manifest, and frontend metadata. After an intentional contract change, run from the repository root:

```powershell
$env:PYTHONPATH="$PWD\backend"
python scripts\generate_contracts.py
python scripts\generate_contracts.py --check
```

Commit all intentional generated changes under `contracts/` and `frontend/src/generated/`. Do not hand-edit generated contract metadata. Call out additive and breaking behavior explicitly in the pull request.

## Verification

On Windows, the closest local equivalent to CI is:

```powershell
.\scripts\doctor.ps1
.\scripts\verify.ps1
```

Use `-SkipContainers` when Docker is unavailable, and state that omission in the pull request. The CI pipeline performs these core checks:

```bash
python -m compileall -q backend
PYTHONPATH=backend python scripts/generate_contracts.py --check
PYTHONPATH=backend python -m pytest -q backend/tests
PYTHONPATH=backend python scripts/benchmark_backend.py --quick --check
cd frontend
npm ci
npm run lint
npm run build
```

Run the smallest relevant checks while iterating, then the full applicable set before requesting review. UI changes should also be exercised with keyboard-only input, reduced motion, a 360x800 viewport, a 768x1024 viewport, and 200% zoom. Include screenshots or a short recording for meaningful visual changes.

## Pull requests

A review-ready pull request should:

1. Explain the concrete outcome, scope, and related issue.
2. List exact automated and manual checks with results.
3. Identify contract, security, data-license, accessibility, performance, and operational-training implications.
4. Include migration or recovery steps when state, configuration, or deployment behavior changes.
5. Update user or operator documentation when behavior changes.

Container changes should pass the merged Compose validation and build in CI. The release-configured stack is a local readiness target; external deployment still requires the controls documented in [docs/RELEASE.md](./docs/RELEASE.md).

By submitting a contribution, you agree that it may be distributed under the repository's [MIT License](./LICENSE).
