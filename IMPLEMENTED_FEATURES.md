# Smart ATC: 50 implemented features

This inventory records capabilities present in the current repository. It does not count roadmap ideas, external hosting, or unimplemented production infrastructure. “Local” means state is process-local and resets when the backend process restarts.

| # | Area | Delivered capability |
| ---: | --- | --- |
| 1 | Flight planning | Search the bundled airport catalog by ICAO or text and retrieve airport details. |
| 2 | Flight planning | Create airport-to-airport demonstrations with validated manual-coordinate fallback for airports outside the catalog. |
| 3 | Flight planning | Create, engage, cancel, and reset explicit route lifecycles. |
| 4 | Navigation | Interpolate airport-to-airport motion with great-circle distance, bearing, and destination-position calculations. |
| 5 | Navigation | Detect and expose 13 deterministic phases from `AT_GATE` through `LANDED`. |
| 6 | Flight state | Synchronize position, heading, bearing, altitude, vertical speed, speed, fuel, ETA, and route progress from one authoritative state. |
| 7 | Simulation | Advance flight dynamics, traffic, weather, phases, and route state on a fixed-step authoritative clock. |
| 8 | Scenario control | Pause and resume physics while keeping the live connection heartbeat available. |
| 9 | Scenario control | Change simulation speed from 0.25x to 120x through validated controls. |
| 10 | Simulator input | Optionally ingest Microsoft Flight Simulator telemetry through SimConnect in the protected default room. |
| 11 | Surveillance | Generate deterministic, room-local synthetic traffic for offline training. |
| 12 | Surveillance | Predict traffic conflicts with closest-point-of-approach distance and time calculations. |
| 13 | Visualization | Render ownship, route, trail, traffic, projections, and selected-contact details on a live Leaflet map. |
| 14 | Visualization | Render a full sector radar with range rings, compass labels, ownship, traffic tags, trails, and projected vectors. |
| 15 | Visualization | Keep traffic filters and selected callsigns linked while switching between map and radar. |
| 16 | Visualization | Support radar range scales, head-up/north-up modes, vector controls, CPA geometry, conflict styling, and responsive full-canvas viewing. |
| 17 | Emergencies | Simulate engine, medical, hydraulic, bird-strike, fuel, communications, smoke/fire, and landing-gear emergencies. |
| 18 | Emergencies | Apply state-driven performance effects and update emergency severity, declarations, and squawk state. |
| 19 | Emergencies | Select diversion guidance and orchestrate stabilize, navigate, communicate, divert, and land actions. |
| 20 | Emergencies | Block emergency resolution until required action, state, and landing criteria are satisfied. |
| 21 | Streaming | Publish authoritative snapshots over WebSocket at a nominal 5 Hz, including an immediate snapshot on connection. |
| 22 | Streaming | Resynchronize through REST when WebSocket delivery is unavailable or a client detects a gap. |
| 23 | Synchronization | Carry runtime session IDs, monotonic transport sequences, source metadata, observation time, and data age in snapshot state. |
| 24 | Synchronization | Track a semantic `state_revision` independently from the 5 Hz transport sequence. |
| 25 | Synchronization | Reject stale-session and out-of-order data and expose degraded, reconnecting, offline, and stale connection states. |
| 26 | Multi-session | Isolate runtime, route, traffic, weather, clearances, emergencies, journal, commands, and model history per training room. |
| 27 | Multi-session | Create, list, inspect, join, keep alive, switch, delete, and locally persist the selected training-room identity. |
| 28 | Multi-session | Enforce configurable room quotas, idle expiry, REST leases, and per-room WebSocket connection limits. |
| 29 | Multi-session | Select the same room consistently through REST headers/query parameters and WebSocket selectors with mismatch close codes. |
| 30 | Multi-session | Clear room-scoped chat, timeline, selections, filters, acknowledgements, and open workflows during a room switch. |
| 31 | Command safety | Wrap protected mutations in typed command metadata with command/idempotency IDs, actor, expected state, issue time, and expiry. |
| 32 | Command safety | Return a revision conflict without mutation when a command targets stale semantic state. |
| 33 | Command safety | Deduplicate concurrent retries so one idempotency key produces one execution and repeatable receipts. |
| 34 | Command safety | Browse room-local command audit records by page, command ID, or idempotency key. |
| 35 | Event history | Record a bounded room-local journal of semantic events without advancing the simulation clock. |
| 36 | Event history | Create periodic snapshot checkpoints with canonical checksums, completeness flags, and truncation metadata. |
| 37 | Event history | Page and filter retained events by search text, event type, and semantic range. |
| 38 | Event history | Inspect retained replay ranges from a checkpoint in an explicitly read-only archive view. |
| 39 | Event history | Create, edit, list, and delete timeline bookmarks. |
| 40 | Event history | Export a room-local journal, checkpoint set, event history, and bookmarks as JSON. |
| 41 | Clearances | Parse structured altitude, heading, speed, frequency, squawk, direct-to, taxi, hold-short, takeoff, and landing instructions. |
| 42 | Clearances | Require and validate a pilot readback before an issued clearance can change flight targets. |
| 43 | Advisory gateway | Expose six allowlisted read tools and three proposal-only tools with strict Pydantic argument/result schemas. |
| 44 | Advisory gateway | Bind proposals to session, sequence, revision, expiry, checksum, evidence, provenance, and deterministic validator results; test them with a 16-case offline baseline. |
| 45 | Communications | Provide local-LLM ATC chat with deterministic fallback, press-and-hold PTT, faster-whisper STT, Edge TTS, and voice/device selection. |
| 46 | Alerts | Persist room-local server acknowledgements and unacknowledgements and manage severity/category filters in an operational alert center. |
| 47 | Operations UI | Provide a searchable command palette, safe keyboard shortcuts, an 80-event live timeline, follow/hold behavior, and telemetry filters. |
| 48 | Contract safety | Commit OpenAPI 3.1 artifacts for 56 HTTP operations, 76 models, and one versioned WebSocket channel with reproducible drift checks. |
| 49 | Offline behavior | Provide an installable PWA shell with install/update prompts, network-first navigation, safe static caching, and read-only offline gating that never queues mutations. |
| 50 | Accessibility and resilience | Provide a skip link, dialog focus trapping and restoration, Escape handling, reduced motion, one-shot critical-alert announcements, responsive layouts, and a React error boundary. |

## Verification snapshot

- 135 backend tests pass.
- Frontend ESLint, TypeScript checks, and the production Vite build pass.
- The contract manifest reports 56 HTTP operations, 76 models, and one WebSocket channel at schema version `3.0.0`.
- The committed local benchmark records 2,400 measured snapshots at 1,104.15 snapshots/s with zero deterministic or cross-room divergence.
- The 558.03 NM VOMM–VABB benchmark covers all 13 phases and ends with 0.000 NM position error.
- One hundred concurrent deliveries of one idempotent command produce one mutation, 99 deduplicated receipts, and zero duplicate mutations.

See [docs/BENCHMARKS.md](./docs/BENCHMARKS.md) for benchmark scope and limitations.
