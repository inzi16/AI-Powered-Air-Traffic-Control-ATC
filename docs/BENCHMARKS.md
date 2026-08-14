# Local backend benchmark

`scripts/benchmark_backend.py` is a reproducible, in-process evidence harness for the Smart Air Traffic Control backend. It measures deterministic simulation and command-layer behavior on one machine. It is **not** a production capacity, HTTP, WebSocket, database, multi-process, or network benchmark.

## Recorded local baseline

The committed [`benchmarks/local-baseline.json`](../benchmarks/local-baseline.json) was captured on Windows 11 with CPython 3.12.13, a 12-logical-CPU Intel x64 machine, and API schema `3.0.0`. The JSON records the full Python executable, compiler, platform, Git revision, working-tree state, configuration, timings, checksums, failures, and gate decisions.

| Evidence | Local result |
|---|---:|
| Fixed-step workload | 8 isolated rooms × 300 measured ticks |
| Timed snapshots | 2,400 |
| Deterministic replay snapshots | 2,400 |
| Snapshot throughput | 1,104.15 snapshots/s |
| Snapshot latency p50 / p95 / p99 | 0.754 / 1.485 / 2.408 ms |
| Deterministic checksum divergences | 0 |
| Shared mutable room objects | 0 |
| Isolation-probe peer divergences | 0 |
| Accelerated route | VOMM → VABB, 558.03 NM |
| Route completion | 225 ticks; 0.465 s local wall time |
| Route phase coverage | 13/13 required phases |
| Final route position error | 0.000 NM |
| Duplicate-command storm | 100 concurrent requests |
| Command outcome | 1 execution, 99 deduplicated responses, 0 duplicate mutations |
| Total harness wall time | 7.125 s |

Timing varies with machine load, power settings, security software, and Python build. Correctness evidence—checksums, isolation, phase coverage, route completion, and exactly-once command counts—is the primary regression signal.

## Reproduce

From the repository root with the backend dependencies installed:

```powershell
python scripts/benchmark_backend.py --output benchmarks/local-baseline.json --check
```

For a conservative CI smoke gate:

```powershell
python scripts/benchmark_backend.py --quick --check
```

The quick profile uses 3 rooms, 75 measured ticks per room, 5 warmup ticks, the same complete VOMM→VABB route, and the same 100-way duplicate-command check. All settings can be overridden; run `python scripts/benchmark_backend.py --help` for the bounded options.

If no `--output` is supplied, canonical JSON is written to stdout. `--check` returns a non-zero process status when any correctness or conservative timing gate fails.

## Method

- Fixed-step simulation uses a constant UTC epoch, fixed `dt`, seeded rooms, and round-robin execution. Wall-clock weather drift is disabled only inside the harness; production code is not changed.
- A second, untimed workload repeats the same inputs. Canonical SHA-256 room checksums must match the measured pass exactly.
- Checksum input excludes timestamps and generated runtime identifiers while retaining flight state, traffic, weather, sequence, revision, scenario control, and room-specific markers.
- The isolation probe changes one room's COM standby value, republishes only that room, and verifies that every peer checksum remains unchanged. Object-identity checks also cover state, weather, traffic, route, emergencies, clearances, journal, and lock ownership.
- The route exercise runs the real `SimulationRuntime`, `RouteAutopilot`, dynamics, traffic, weather, and phase detector at `120×`. It must finish on the destination with full progress and cover gate, pushback, taxi, hold-short, takeoff, climb, cruise, descent, approach, landing, and landed phases.
- The retry exercise sends one revision-bound command envelope through `CommandLedger.execute` from 100 concurrent coroutines. It requires one executor mutation, one event, one ledger entry, one sequence/revision increment, and 99 deduplicated receipts.

## Conservative gates

Quick and default `--check` runs require:

- zero fixed-step failures;
- at least 50 snapshots/s;
- p95 snapshot latency at or below 50 ms and p99 at or below 100 ms;
- zero deterministic checksum divergence and zero cross-room isolation divergence;
- no shared mutable room components;
- complete route, every required phase, destination error at or below 0.1 NM, on-ground stop, and full progress;
- route wall time at or below 15 seconds in quick mode or 30 seconds otherwise;
- exactly one command mutation/event/ledger entry and no duplicate mutation.

These thresholds are intentionally much looser than the recorded workstation result so ordinary CI jitter does not masquerade as a product regression. Production sizing requires a separate deployed load test with real HTTP/WebSocket clients, persistence, authentication, telemetry, and representative concurrency.
