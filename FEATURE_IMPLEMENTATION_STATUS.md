# Smart ATC launch-plan implementation status

This file maps the targets in [FEATURE_LAUNCH_PLAN.md](./FEATURE_LAUNCH_PLAN.md) to the current repository. It deliberately separates a working local foundation from a public-production implementation.

## Status definitions

- **Implemented locally:** the described core behavior exists and is tested for the current single-process/local architecture; this does not imply distributed durability or public-production approval.
- **Foundation:** useful parts exist, but the launch-plan feature or its acceptance gate is not complete.
- **Planned:** the launch-plan feature is not implemented beyond adjacent baseline behavior.

## Tranche 1: control plane and safety rails

| ID | Status | Honest current state and remaining gap |
| --- | --- | --- |
| SC-001 | Implemented locally | The session registry isolates runtime, traffic, weather, route, clearances, emergencies, journal, commands, and model history. REST/WS selectors, quotas, expiry, leases, and a room lobby exist. It remains a single-process registry without authenticated membership or distributed coordination. |
| SC-002 | Planned | There is no OIDC login, user directory, session membership, or pilot/controller/instructor/observer RBAC. Production mode supports a service API key only. |
| SC-003 | Planned | Events, checkpoints, commands, acknowledgements, transcripts, and rooms are in memory. There are no PostgreSQL/PostGIS migrations or restart-resume durability guarantees. |
| SC-004 | Foundation | Revision-bound command metadata, expiry, stale-state conflicts, idempotent deduplication, receipts, and audit lookup exist. The ledger is room-local/in-memory, so its exactly-once history does not survive process restart or coordinate across replicas. |
| SC-005 | Foundation | A bounded journal, periodic checksummed checkpoints, retained replay ranges, bookmarks, and a read-only archive exist. The system does not rebuild state by replaying a durable event log and has no seek/branch engine or restart continuity. |
| SC-006 | Foundation | Reproducible OpenAPI 3.1 artifacts, a compatibility manifest, TypeScript contract metadata, a schema-major client guard, and an explicit WebSocket contract exist. A fully generated frontend client and a formal cross-version negotiation matrix remain. |
| SC-007 | Foundation | Snapshots expose source/freshness information and gateway proposals require evidence and provenance. There is no central licensed-source registry, AIRAC lifecycle, ingestion pipeline, or product-wide expiry policy. |
| SC-008 | Foundation | Health/readiness APIs and client connection/data-age diagnostics exist. OpenTelemetry traces, structured correlated telemetry, metrics/SLO dashboards, redaction policy, and operational alerting do not. |
| SC-009 | Foundation | The repository has 135 backend tests, contract drift checks, deterministic/isolation benchmarks, frontend lint/type/build gates, and CI configuration. It does not yet have Playwright browser coverage, property/chaos tests, or a deployed 100-session load result. |
| SC-010 | Foundation | Six read-only tools, three proposal-only tools, strict schemas, evidence/provenance binding, revalidation, injection/tamper/stale defenses, deterministic fallback, and a 16-case offline eval exist. The 10,000-case reviewed safety target and complete proposal review/commit UX are not delivered. |

## Tranche 2: navigation, trajectory, and safety intelligence

| ID | Status | Honest current state and remaining gap |
| --- | --- | --- |
| SC-011 | Planned | The app retains a small bundled airport catalog plus manual-coordinate fallback. It has no versioned runway/fix/airway/navaid ingestion, cycle activation, rollback, or PostGIS store. |
| SC-012 | Planned | Current route planning is one direct origin-to-destination path. There is no editable multi-leg graph, airway expansion, discontinuity handling, alternates, or leg constraints. |
| SC-013 | Planned | SID, STAR, approach, hold, missed-approach, and ARINC-style leg compilation are not implemented. |
| SC-014 | Planned | Weather is deterministic/synthetic for training. There is no time-aware METAR, TAF, SIGMET/G-AIRMET, or winds-aloft ingestion and validity model. |
| SC-015 | Planned | Current dynamics use a generic training-aircraft model. There is no pluggable, licensed, aircraft-specific performance-profile system. |
| SC-016 | Foundation | Direct great-circle tracking, bearing updates, wind input, and stable deterministic motion exist. Multi-leg LNAV, cross-track capture, fly-by/fly-over sequencing, and turn anticipation do not. |
| SC-017 | Foundation | Deterministic phase targets, climb/descent/approach/landing progression, and emergency caps exist. Energy-aware VNAV, constraint reachability, TOC/TOD, go-around, flare, braking, and aircraft-specific landing assurance do not. |
| SC-018 | Planned | The UI has ETA, route progress, trails, and projected traffic vectors, but no uncertainty-aware timestamped 4D ownship trajectory service or P50/P90 corridors. |
| SC-019 | Planned | Runway configuration, declared-distance performance, wind components, closures, occupancy, and landing-margin comparison are not implemented. |
| SC-020 | Planned | Terrain/obstacle data, corridor sampling, coverage uncertainty, and terrain alerting are not implemented. |

## Tranche 3: clearances, speech, surveillance, and coordination

| ID | Status | Honest current state and remaining gap |
| --- | --- | --- |
| SC-021 | Foundation | A typed parser covers common altitude, heading, speed, frequency, squawk, direct-to, ground, takeoff, and landing instructions. It is not the complete versioned compound-clearance AST described by the plan. |
| SC-022 | Foundation | Press-and-hold PTT, faster-whisper transcription, editable text, voice/device controls, and upload limits exist. Streaming ASR, vocabulary biasing, n-best alternatives, token confidence, noise metrics, and consented retention do not. |
| SC-023 | Planned | There are no reviewed, versioned FAA/ICAO jurisdiction phraseology packs with source paragraphs and effective dates. |
| SC-024 | Foundation | A clearance must receive a validated text readback before targets change, and rejected readbacks remain non-mutating. The full slot-level 10,000-case semantic safety corpus and correction history are not delivered. |
| SC-025 | Planned | The gateway can carry evidence/provenance, but there is no signed, versioned aviation retrieval corpus, hybrid search, reranking, citation-support evaluation, or coverage-aware abstention layer. |
| SC-026 | Planned | Nearby synthetic traffic exists, but tracks are not independently controlled aircraft actors with separate plans, phases, performance, and command queues. |
| SC-027 | Foundation | The CPA engine predicts ownship/traffic conflicts with severity and UI highlighting. Configurable regulatory minima, wake rules, RVSM, runway-incursion logic, spatial indexing, and measured false-alert rates do not. |
| SC-028 | Planned | There is no bounded maneuver search that ranks feasible conflict-resolution candidates against performance, terrain, weather, procedure, and secondary-conflict constraints. |
| SC-029 | Planned | Sector polygons, controller ownership, handoffs, point-outs, coordination events, and frequency-transfer state machines are not implemented. |
| SC-030 | Foundation | The chosen radar/map design includes range/orientation/vector controls, linked selection, filters, CPA geometry, contact details, trails, and a responsive full-canvas mode. Server-side spatial filtering, dense-label placement, procedure/weather/terrain layers, measurements, and a verified 100-track/55-FPS gate remain. |

## Tranche 4: emergencies, scenarios, replay, and learning

| ID | Status | Honest current state and remaining gap |
| --- | --- | --- |
| SC-031 | Foundation | Eight emergencies apply selected performance degradation and operational consequences. A general aircraft-subsystem graph with sensor validity, tanks/leaks, electrical/hydraulic coupling, brakes, pressurization, and telemetry-backed repair state does not exist. |
| SC-032 | Foundation | Emergency categories have deterministic, ordered training checklists and generic fallback behavior. They are not licensed, versioned, aircraft/phase-specific emergency packs with coverage and expiry controls. |
| SC-033 | Foundation | Emergencies expose severity, acknowledgements, action completion, squawks, resolution criteria, and guarded transitions. The full detected-to-resolved telemetry-driven lifecycle, escalation timers, immutable durable transitions, and exhaustive property tests remain. |
| SC-034 | Foundation | The runtime provides nearest-airport diversion guidance. It does not rank multiple candidates using runway, weather, terrain, fuel, damage, services, uncertainty, and traceable rejection reasons. |
| SC-035 | Foundation | Preset and custom scenario APIs plus a scenario launcher exist. There is no visual timeline/condition authoring studio, draft/publish lifecycle, versioned manifest editor, or import validation workflow. |
| SC-036 | Planned | There is no constrained LLM scenario generator, typed manifest diff, deterministic rollout validator, repair loop, or generated-scenario provenance UI. |
| SC-037 | Foundation | Pause/resume, 0.25x–120x speed, checkpoints, event ranges, and read-only replay inspection exist. Seeking, branch lineage, instructor overrides, branch comparison, and deterministic branch reconstruction do not. |
| SC-038 | Planned | There is no versioned competency rubric, safety cap, evidence-linked score, or instructor adjustment workflow. |
| SC-039 | Planned | The event timeline and JSON export are foundations, but there is no deterministic score report, evidence-linked coaching, synchronized debrief charts, or downloadable after-action report. |
| SC-040 | Planned | Learner profiles, proficiency histories, consented adaptive recommendations, confidence/recency models, and privacy controls are not implemented. |

## Tranche 5: collaboration, accessibility, and production launch

| ID | Status | Honest current state and remaining gap |
| --- | --- | --- |
| SC-041 | Foundation | The room lobby supports create/list/join/switch/keepalive/delete and connection counts. Invitations, authenticated membership, roster presence, reconnect identities, host controls, locks, and durable rooms do not. |
| SC-042 | Planned | The app has one shared operations console; separate pilot, controller, instructor, and observer layouts with server-enforced position permissions are not implemented. |
| SC-043 | Foundation | Optional SimConnect input, synthetic traffic, and source labels exist. There is no pluggable ADS-B/commercial/recorded adapter framework with licensing, deduplication, latency/coverage scoring, coast logic, and replay fixtures. |
| SC-044 | Foundation | A room-local JSON journal export exists. Signed portable packages, import verification, privacy redaction, expiring share links, audio references, and PDF reports do not. |
| SC-045 | Foundation | The UI has a skip link, focus traps/restoration, keyboard workflows, non-color labels, reduced motion, responsive layouts, and critical-alert live announcements. A formal WCAG 2.2 AA audit, complete 200% zoom/screen-reader matrix, color-vision themes, and automated accessibility gate remain. |
| SC-046 | Implemented locally | The installable PWA shell has static-asset caching, safe updates, responsive layouts, install prompts, and explicit offline/backend-offline read-only behavior that never queues commands. Cross-browser release automation and a public deployment are not implied. |
| SC-047 | Foundation | The app has an original cabin-style intro chime, PTT/radio audio, TTS voices/devices, alert sounds, captions through visible alert text, acknowledgement, and mute controls. Typed notification priority, audio ducking, haptics, and full reduced-sensory policy remain. |
| SC-048 | Planned | There is no user privacy center, purpose-specific consent history, tenant retention policy, encrypted recording store, subject export/delete workflow, or legal-hold separation. |
| SC-049 | Foundation | Health/readiness endpoints, room quota telemetry, gateway policy/eval metadata, diagnostics, CI, and release checks exist. There is no authenticated operations console, feature-flag/canary system, source/model registry, SLO view, or signed rollback control. |
| SC-050 | Foundation | Local Docker/Nginx packaging adds non-root execution, API-key forwarding, security headers, rate/body/resource limits, health checks, read-only containers, CI, and runbooks. TLS/OIDC, managed secrets, SBOM/security sign-off, persistent backups, restore/RPO/RTO drills, rolling migration rollback, deployed load/failover tests, and public hosting remain future work. |

## What “ready” means today

Smart ATC is ready for local demonstrations, portfolio use, feature development, and repeatable correctness testing. It is configured for a release-like local container run, but no external deployment has been performed. The current benchmark is local, single-process evidence—not a concurrency or capacity claim for a deployed service.

The public-production gate remains dependent on OIDC/RBAC, PostgreSQL/PostGIS, licensed data, OpenTelemetry/SLOs, privacy and retention controls, managed TLS/secrets, backups and recovery drills, security review, and deployed browser/load/failover testing.
