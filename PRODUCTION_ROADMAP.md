# Smart Air Traffic Control (ATC) production and 100x roadmap

The revamp establishes a credible single-node training product. A real production system should now become more reliable, more explainable, and more scalable in that order.

## P0 — harden what exists

1. Keep one server-side session object per authenticated user or training room. The current in-process room registry now isolates runtime, model context, streams, commands, and journals; a distributed deployment must preserve that boundary when moving the registry to durable infrastructure.
2. Move browser authentication to an OIDC/OAuth2 gateway with short-lived, scoped tokens. Keep the existing API key for trusted service-to-service traffic only.
3. Persist routes, events, clearances, emergencies, transcripts, and audit records in PostgreSQL/PostGIS. Treat the in-memory snapshot as a cache, not the record of truth.
4. Add idempotency keys to mutations, optimistic concurrency with expected sequence/revision, command deduplication, rate limits, and immutable audit events.
5. Put the API behind TLS, a reverse proxy, request/body limits, dependency and container scanning, secret management, backups, retention policies, and disaster-recovery tests.
6. Add browser E2E tests for route start, full-flight progress, stale/reconnect behavior, clearance readback, every emergency, keyboard navigation, mobile drawers, and reduced motion.

## P1 — make the simulator substantially smarter

- Replace the two-point route with a flight-plan graph: SIDs, STARs, approaches, airway legs, altitude/speed constraints, runway geometry, holds, missed approaches, and alternates.
- Use energy-aware vertical navigation. Compute climb/descent profiles from aircraft performance, weight, density altitude, wind, restrictions, runway elevation, and required landing distance.
- Add a deterministic flight-management controller with cross-track error, turn anticipation, bank/vertical-rate limits, wind correction, flare/rollout, and go-around logic.
- Model runway occupancy, wake categories, surface conflicts, minimum separation, terrain/obstacle envelopes, fuel reserves, MEL-style degraded systems, and weather minima.
- Build scenario authoring and replay: pause, scrub, branch from any event, instructor overrides, objectives, scoring, automatic debrief, and shareable replay files.

## P1 — AI capacity without unsafe autonomy

- Give the model read-only typed tools for snapshot, route, traffic, airport, weather, procedures, and transcript data. All suggested commands must pass schemas and deterministic validators.
- Use structured output for intent, clearance proposal, rationale, confidence, assumptions, sources, and uncertainty. Never parse operational commands from unconstrained prose.
- Build an evaluation suite with golden ATC conversations, aviation-number variants, readback errors, hallucination traps, emergencies, conflicts, latency targets, and regression scoring.
- Add retrieval over curated training procedures, airport data, phraseology, aircraft checklists supplied by the user, and local scenario knowledge. Every answer should show provenance and data age.
- Use a cascade: fast rule/template response for time-critical events, small local model for routine radio, larger model for debrief and scenario generation. Cache static context and bound every model timeout.
- Fine-tune only after collecting consented, labeled simulation transcripts and establishing evals. Better tools, context, and validation will usually outperform premature fine-tuning.

## P2 — modern open-source platform

| Need | Recommended direction |
| --- | --- |
| Vector maps | MapLibre GL JS with self-hosted OpenMapTiles/PMTiles; deck.gl for high-volume traffic layers |
| 3D globe/terrain | Optional CesiumJS training view |
| Airport data | OurAirports for public-domain bootstrap data, then a licensed aviation source for commercial accuracy |
| Weather | NOAA Aviation Weather server-side ingestion with caching and explicit observation time |
| Spatial data | PostgreSQL + PostGIS |
| Event transport | NATS JetStream for durable commands/events; WebSocket gateway for clients |
| Low-latency cache | Valkey |
| Object storage | S3-compatible storage for audio, replays, exports, and model-eval artifacts |
| Observability | OpenTelemetry traces/metrics/logs, Prometheus, Grafana, and Sentry-class error reporting |
| Local inference | llama.cpp or vLLM; whisper.cpp/Silero for offline voice pipelines |
| Contracts | OpenAPI-generated clients plus JSON Schema/Protobuf for durable events |

Do not use public OpenStreetMap tile servers as a production tile backend. Host or license an appropriate tile service and preserve attribution.

## P2 — product features worth building

- Multi-aircraft sector mode with handoffs, coordination, strips, runway configuration, arrival/departure metering, sector load, and instructor positions.
- Live-data adapter interfaces for commercial flight/ADS-B providers, with licensing, latency, coverage, and quality clearly separated from synthetic training traffic.
- Emergency command mode with aircraft-specific checklists, suitable-airport ranking, runway/weather/fuel constraints, rescue coordination, and after-action scoring.
- Collaborative rooms, roles, session invitations, annotations, shared replays, instructor chat, and classroom analytics.
- Accessibility modes for color vision, high contrast, keyboard-only control, screen-reader traffic summaries, captions, and configurable audio/haptics.
- Desktop packaging only if simulator integrations require it; otherwise keep the core as a browser client and server-side runtime.

## Success gates

- No state mutation from a read endpoint or model response.
- Every command is authenticated, authorized, validated, idempotent, auditable, and tied to a state revision.
- A reconnecting client converges to the same snapshot without rewinding sequence or duplicating an action.
- Emergency UI appears within one stream tick and cannot show “resolved” until explicit criteria pass.
- Route and conflict calculations have unit/property tests and scenario-level golden tests.
- AI evals publish accuracy, unsafe-action rate, hallucination rate, readback sensitivity, latency, and fallback rate per release.
- Product language consistently says simulation/training; no screen implies operational certification.
