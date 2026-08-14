import {
  createDefaultSimData,
  type Advisory,
  type AdvisorySeverity,
  type AirportReference,
  type ConflictAlert,
  type DataQuality,
  type DataQualityIssue,
  type EmergencyAction,
  type EmergencyState,
  type LegacyRouteSummary,
  type RouteAirport,
  type RoutePlan,
  type RouteProgress,
  type RouteWaypoint,
  type ScenarioControlState,
  type SimData,
  type SimSnapshotPayload,
  type SimTransport,
  type SnapshotRejectionReason,
  type SnapshotSchemaInfo,
  type SnapshotSourceInfo,
  type SnapshotTimestamps,
  type TrafficContact,
  type WeatherData,
} from '../types/sim';
import { SNAPSHOT_SCHEMA_VERSION } from '../generated/contractMetadata';
import {
  clearAcceptedCommandContext,
  updateAcceptedCommandContext,
} from './commandContext';

type UnknownRecord = Record<string, unknown>;

const LEGACY_SCHEMA: SnapshotSchemaInfo = { name: 'atc.sim.snapshot', version: 'legacy' };
const MAX_REASONABLE_DATA_AGE_MS = 15_000;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXPECTED_SCHEMA_MAJOR = Number.parseInt(SNAPSHOT_SCHEMA_VERSION.split('.')[0], 10);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function integer(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 'true') return true;
  if (value === 0 || value === 'false') return false;
  return null;
}

function numberOr(value: unknown, fallback: number, minimum?: number, maximum?: number): number {
  const parsed = finiteNumber(value);
  if (parsed === null) return fallback;
  return Math.min(maximum ?? Number.POSITIVE_INFINITY, Math.max(minimum ?? Number.NEGATIVE_INFINITY, parsed));
}

function nullableNumber(value: unknown, fallback: number | null = null): number | null {
  if (value === null) return null;
  return finiteNumber(value) ?? fallback;
}

function normalizedRatioOrNull(value: unknown): number | null {
  const raw = finiteNumber(value);
  if (raw === null) return null;
  const ratio = raw > 1 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, ratio));
}

function stringOr(value: unknown, fallback: string): string {
  return text(value) ?? fallback;
}

function nullableText(value: unknown, fallback: string | null = null): string | null {
  if (value === null) return null;
  return text(value) ?? fallback;
}

function normalizedHeading(value: unknown, fallback: number): number {
  const parsed = finiteNumber(value);
  if (parsed === null) return fallback;
  return ((parsed % 360) + 360) % 360;
}

function normalizedLongitude(value: unknown, fallback: number): number {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < -540 || parsed > 540) return fallback;
  return ((((parsed + 180) % 360) + 360) % 360) - 180;
}

function stringList(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item): item is string => typeof item === 'string');
}

function recordList(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function firstValue(records: UnknownRecord[], keys: string[]): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (Object.hasOwn(record, key)) return record[key];
    }
  }
  return undefined;
}

type SchemaVersionCheck =
  | { compatible: true }
  | { compatible: false; reason: 'schema_version_invalid' | 'schema_version_incompatible' };

function explicitSchemaVersions(records: UnknownRecord[]): unknown[] {
  const versions: unknown[] = [];
  for (const record of records) {
    for (const key of ['schema_version', 'schemaVersion']) {
      if (Object.hasOwn(record, key)) versions.push(record[key]);
    }
    if (!Object.hasOwn(record, 'schema')) continue;
    const schema = record.schema;
    if (typeof schema === 'string') {
      const separator = schema.lastIndexOf('/');
      if (separator > 0) versions.push(schema.slice(separator + 1));
      else if (/^\d/.test(schema)) versions.push(schema);
    }
    if (isRecord(schema) && Object.hasOwn(schema, 'version')) {
      versions.push(schema.version);
    }
  }
  return versions;
}

function checkSchemaVersion(records: UnknownRecord[]): SchemaVersionCheck {
  const versions = explicitSchemaVersions(records);
  // A versionless payload is the only supported legacy path.
  if (!versions.length) return { compatible: true };
  for (const version of versions) {
    if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
      return { compatible: false, reason: 'schema_version_invalid' };
    }
    if (Number.parseInt(version.split('.')[0], 10) !== EXPECTED_SCHEMA_MAJOR) {
      return { compatible: false, reason: 'schema_version_incompatible' };
    }
  }
  return { compatible: true };
}

export function snapshotSchemaRejectionMessage(reason: SnapshotRejectionReason): string | null {
  if (reason === 'schema_version_invalid') {
    return `The backend sent a malformed snapshot schema version. This interface requires ${EXPECTED_SCHEMA_MAJOR}.x.`;
  }
  if (reason === 'schema_version_incompatible') {
    return `The backend snapshot uses an incompatible major version. Update SMART ATC so the interface and backend both use ${EXPECTED_SCHEMA_MAJOR}.x.`;
  }
  return null;
}

interface UnpackedPayload {
  envelope: UnknownRecord;
  state: UnknownRecord;
  metadata: UnknownRecord[];
}

function unpackPayload(payload: unknown): UnpackedPayload | null {
  if (!isRecord(payload)) return null;
  const envelope = isRecord(payload.snapshot) ? payload.snapshot : payload;
  const data = isRecord(envelope.data) ? envelope.data : null;
  const nestedState = data && isRecord(data.state)
    ? data.state
    : isRecord(envelope.state)
      ? envelope.state
      : data;
  const state = nestedState ? { ...envelope, ...(data ?? {}), ...nestedState } : envelope;
  const metadata = [
    ...(envelope !== payload ? [payload] : []),
    envelope.metadata,
    envelope.meta,
    payload.metadata,
    payload.meta,
  ]
    .filter(isRecord);
  return { envelope, state, metadata };
}

function normalizeTraffic(value: unknown, fallback: TrafficContact[]): TrafficContact[] {
  if (!Array.isArray(value)) return fallback.map(contact => ({ ...contact }));
  return recordList(value).map((contact) => ({
    callsign: stringOr(contact.callsign, 'UNKNOWN'),
    type: stringOr(contact.type, 'unknown'),
    lat: numberOr(contact.lat, 0, -90, 90),
    lon: normalizedLongitude(contact.lon, 0),
    altitude: numberOr(contact.altitude, 0),
    heading: normalizedHeading(contact.heading, 0),
    speed: numberOr(contact.speed, 0, 0),
    squawk: stringOr(contact.squawk, '----'),
    on_ground: booleanValue(contact.on_ground) ?? false,
    range_nm: numberOr(contact.range_nm, 0, 0),
    bearing: normalizedHeading(contact.bearing, 0),
  }));
}

function normalizeConflicts(value: unknown, fallback: ConflictAlert[]): ConflictAlert[] {
  if (!Array.isArray(value)) return fallback.map(conflict => ({ ...conflict }));
  return recordList(value).map((conflict) => {
    const currentRange = numberOr(conflict.current_range_nm ?? conflict.range_nm, 0, 0);
    const currentVerticalSeparation = numberOr(
      conflict.current_vertical_separation_ft ?? conflict.alt_diff_ft,
      0,
      0,
    );
    const bearing = normalizedHeading(conflict.bearing_deg ?? conflict.bearing, 0);
    const timeToCpa = integer(conflict.time_to_cpa_seconds ?? conflict.time_to_cpa_s);
    const cpaVertical = nullableNumber(conflict.cpa_vertical_separation_ft ?? conflict.cpa_vertical_ft);
    return {
      callsign: stringOr(conflict.callsign, 'UNKNOWN'),
      range_nm: currentRange,
      alt_diff_ft: currentVerticalSeparation,
      bearing,
      ...(text(conflict.severity) !== null ? { severity: stringOr(conflict.severity, 'traffic') } : {}),
      ...(text(conflict.conflict_id) !== null ? { conflict_id: stringOr(conflict.conflict_id, '') } : {}),
      current_range_nm: currentRange,
      current_vertical_separation_ft: currentVerticalSeparation,
      bearing_deg: bearing,
      ...(finiteNumber(conflict.closing_rate_kts) !== null
        ? { closing_rate_kts: finiteNumber(conflict.closing_rate_kts) as number }
        : {}),
      ...(timeToCpa !== null ? {
        time_to_cpa_seconds: Math.max(0, timeToCpa),
        time_to_cpa_s: Math.max(0, timeToCpa),
        time_to_closest_approach_sec: Math.max(0, timeToCpa),
      } : {}),
      ...(finiteNumber(conflict.cpa_distance_nm) !== null
        ? { cpa_distance_nm: Math.max(0, finiteNumber(conflict.cpa_distance_nm) as number) }
        : {}),
      ...(cpaVertical !== null ? {
        cpa_vertical_separation_ft: Math.max(0, cpaVertical),
        cpa_vertical_ft: Math.max(0, cpaVertical),
      } : {}),
      ...(integer(conflict.lookahead_seconds) !== null
        ? { lookahead_seconds: Math.max(1, integer(conflict.lookahead_seconds) as number) }
        : {}),
      ...(text(conflict.advisory) !== null ? { advisory: stringOr(conflict.advisory, '') } : {}),
    };
  });
}

function normalizeWeather(value: unknown, fallback: WeatherData | null): WeatherData | null {
  if (value === null) return null;
  if (!isRecord(value)) return fallback ? { ...fallback } : null;
  return {
    wind_dir: normalizedHeading(value.wind_dir, fallback?.wind_dir ?? 0),
    wind_kts: numberOr(value.wind_kts, fallback?.wind_kts ?? 0, 0),
    gust_kts: numberOr(value.gust_kts, fallback?.gust_kts ?? 0, 0),
    visibility_km: numberOr(value.visibility_km, fallback?.visibility_km ?? 0, 0),
    ceiling_ft: nullableNumber(value.ceiling_ft, fallback?.ceiling_ft ?? null),
    qnh_hpa: numberOr(value.qnh_hpa, fallback?.qnh_hpa ?? 1013.25, 800, 1_200),
    temp_c: numberOr(value.temp_c, fallback?.temp_c ?? 15, -100, 100),
    dewpoint_c: numberOr(value.dewpoint_c, fallback?.dewpoint_c ?? 10, -120, 100),
  };
}

function normalizeAirport(value: unknown, fallback: AirportReference | null): AirportReference | null {
  if (value === null) return null;
  if (!isRecord(value)) return fallback ? { ...fallback, rwys: [...fallback.rwys], freq: { ...fallback.freq } } : null;
  const rawFreq = isRecord(value.freq) ? value.freq : {};
  const freq: Record<string, number> = {};
  for (const [name, frequency] of Object.entries(rawFreq)) {
    const parsed = finiteNumber(frequency);
    if (parsed !== null) freq[name] = parsed;
  }
  return {
    icao: stringOr(value.icao, fallback?.icao ?? ''),
    name: stringOr(value.name, fallback?.name ?? ''),
    city: stringOr(value.city, fallback?.city ?? ''),
    country: stringOr(value.country, fallback?.country ?? ''),
    lat: numberOr(value.lat, fallback?.lat ?? 0, -90, 90),
    lon: normalizedLongitude(value.lon, fallback?.lon ?? 0),
    distance_nm: numberOr(value.distance_nm, fallback?.distance_nm ?? 0, 0),
    elev: numberOr(value.elev ?? value.elevation_ft, fallback?.elev ?? 0),
    rwys: stringList(value.rwys ?? value.runways, fallback?.rwys),
    freq: Object.keys(freq).length > 0 ? freq : { ...(fallback?.freq ?? {}) },
  };
}

function normalizeRouteAirport(value: unknown): RouteAirport | null {
  if (!isRecord(value)) return null;
  const icao = text(value.icao) ?? text(value.ident) ?? '';
  const lat = finiteNumber(value.lat);
  const lon = finiteNumber(value.lon);
  if (icao === '' && (lat === null || lon === null)) return null;
  return {
    icao,
    iata: nullableText(value.iata),
    name: nullableText(value.name),
    lat: Math.min(90, Math.max(-90, lat ?? 0)),
    lon: normalizedLongitude(lon, 0),
    elevation_ft: nullableNumber(value.elevation_ft ?? value.elev),
    runway: nullableText(value.runway),
    catalog_source: nullableText(value.catalog_source),
  };
}

function normalizeWaypoint(value: UnknownRecord, index: number): RouteWaypoint {
  const ident = text(value.ident) ?? text(value.name) ?? text(value.id) ?? `WP${index + 1}`;
  const constraint = isRecord(value.altitude_constraint) ? value.altitude_constraint : null;
  return {
    id: stringOr(value.id, ident),
    ident,
    name: nullableText(value.name),
    type: stringOr(value.type, 'fix'),
    lat: numberOr(value.lat, 0, -90, 90),
    lon: normalizedLongitude(value.lon, 0),
    altitude_ft: nullableNumber(value.altitude_ft),
    altitude_constraint: constraint ? {
      type: stringOr(constraint.type, 'at'),
      minimum_ft: nullableNumber(constraint.minimum_ft),
      maximum_ft: nullableNumber(constraint.maximum_ft),
    } : null,
    speed_constraint_kts: nullableNumber(value.speed_constraint_kts),
    airway: nullableText(value.airway),
  };
}

function normalizeRoutePlan(value: unknown, fallback: RoutePlan | null): RoutePlan | null {
  if (value === null) return null;
  if (!isRecord(value)) return fallback ? { ...fallback, waypoints: fallback.waypoints.map(item => ({ ...item })) } : null;
  return {
    id: stringOr(value.id ?? value.route_id, fallback?.id ?? 'active-route'),
    route_id: stringOr(value.route_id ?? value.id, fallback?.route_id ?? fallback?.id ?? 'active-route'),
    revision: integer(value.revision) ?? fallback?.revision ?? 0,
    status: stringOr(value.status, fallback?.status ?? 'active'),
    origin: normalizeRouteAirport(value.origin) ?? fallback?.origin ?? null,
    destination: normalizeRouteAirport(value.destination) ?? fallback?.destination ?? null,
    alternate: value.alternate === null ? null : normalizeRouteAirport(value.alternate) ?? fallback?.alternate ?? null,
    departure_procedure: nullableText(value.departure_procedure ?? value.sid, fallback?.departure_procedure ?? null),
    arrival_procedure: nullableText(value.arrival_procedure ?? value.star, fallback?.arrival_procedure ?? null),
    approach: nullableText(value.approach, fallback?.approach ?? null),
    cruise_altitude_ft: nullableNumber(value.cruise_altitude_ft, fallback?.cruise_altitude_ft ?? null),
    cruise_speed_kts: nullableNumber(value.cruise_speed_kts, fallback?.cruise_speed_kts ?? null),
    total_distance_nm: nullableNumber(value.total_distance_nm, fallback?.total_distance_nm ?? null),
    estimated_duration_sec: nullableNumber(value.estimated_duration_sec, fallback?.estimated_duration_sec ?? null),
    waypoints: Array.isArray(value.waypoints)
      ? recordList(value.waypoints).map(normalizeWaypoint)
      : fallback?.waypoints.map(item => ({ ...item })) ?? [],
    created_at: nullableText(value.created_at, fallback?.created_at ?? null),
    updated_at: nullableText(value.updated_at, fallback?.updated_at ?? null),
    autopilot_engaged: booleanValue(value.autopilot_engaged) ?? fallback?.autopilot_engaged ?? false,
    original_destination: value.original_destination === null
      ? null
      : normalizeRouteAirport(value.original_destination) ?? fallback?.original_destination ?? null,
    time_scale: numberOr(value.time_scale, fallback?.time_scale ?? 1, 0),
    phase: stringOr(value.phase, fallback?.phase ?? 'UNKNOWN'),
    started_at: nullableText(value.started_at, fallback?.started_at ?? null),
    diverted: booleanValue(value.diverted) ?? fallback?.diverted ?? false,
    diversion_reason: nullableText(value.diversion_reason, fallback?.diversion_reason ?? null),
  };
}

function normalizeRouteProgress(value: unknown, fallback: RouteProgress | null): RouteProgress | null {
  if (value === null) return null;
  if (!isRecord(value)) return fallback ? { ...fallback } : null;
  const rawRatio = finiteNumber(value.completion_ratio ?? value.progress);
  const normalizedRatio = rawRatio !== null && rawRatio > 1 ? rawRatio / 100 : rawRatio;
  return {
    route_id: nullableText(value.route_id ?? value.id, fallback?.route_id ?? null),
    active_leg_index: Math.max(0, integer(value.active_leg_index) ?? fallback?.active_leg_index ?? 0),
    previous_waypoint_id: nullableText(value.previous_waypoint_id, fallback?.previous_waypoint_id ?? null),
    next_waypoint_id: nullableText(value.next_waypoint_id, fallback?.next_waypoint_id ?? null),
    distance_flown_nm: numberOr(value.distance_flown_nm, fallback?.distance_flown_nm ?? 0, 0),
    distance_remaining_nm: numberOr(
      value.distance_remaining_nm ?? value.remaining_distance_nm,
      fallback?.distance_remaining_nm ?? 0,
      0,
    ),
    leg_distance_remaining_nm: nullableNumber(value.leg_distance_remaining_nm, fallback?.leg_distance_remaining_nm ?? null),
    cross_track_error_nm: nullableNumber(value.cross_track_error_nm, fallback?.cross_track_error_nm ?? null),
    track_error_deg: nullableNumber(value.track_error_deg, fallback?.track_error_deg ?? null),
    completion_ratio: Math.min(1, Math.max(0, normalizedRatio ?? fallback?.completion_ratio ?? 0)),
    eta: nullableText(value.eta, fallback?.eta ?? null),
    estimated_time_remaining_sec: nullableNumber(
      value.estimated_time_remaining_sec ?? value.eta_seconds,
      fallback?.estimated_time_remaining_sec ?? null,
    ),
    on_route: booleanValue(value.on_route) ?? fallback?.on_route ?? true,
    last_waypoint_passed_at: nullableText(value.last_waypoint_passed_at, fallback?.last_waypoint_passed_at ?? null),
    bearing_deg: nullableNumber(value.bearing_deg, fallback?.bearing_deg ?? null),
    eta_seconds: nullableNumber(value.eta_seconds, fallback?.eta_seconds ?? null),
    wall_clock_eta_seconds: nullableNumber(value.wall_clock_eta_seconds, fallback?.wall_clock_eta_seconds ?? null),
    status: stringOr(value.status, fallback?.status ?? 'active'),
    autopilot_engaged: booleanValue(value.autopilot_engaged) ?? fallback?.autopilot_engaged ?? false,
    time_scale: numberOr(value.time_scale, fallback?.time_scale ?? 1, 0),
    phase: stringOr(value.phase, fallback?.phase ?? 'UNKNOWN'),
    diverted: booleanValue(value.diverted) ?? fallback?.diverted ?? false,
    diversion_reason: nullableText(value.diversion_reason, fallback?.diversion_reason ?? null),
  };
}

function normalizeLegacyRoute(
  value: unknown,
  plan: RoutePlan | null,
  progress: RouteProgress | null,
  fallback: LegacyRouteSummary | null,
): LegacyRouteSummary | null {
  if (value === null && plan === null) return null;
  const record = isRecord(value) ? value : {};
  if (!isRecord(value) && plan === null && progress === null) {
    return fallback ? { ...fallback, waypoints: fallback.waypoints?.map(waypoint => ({ ...waypoint })) } : null;
  }
  const rawWaypoints = Array.isArray(record.waypoints)
    ? recordList(record.waypoints).map(waypoint => ({
        lat: numberOr(waypoint.lat, 0, -90, 90),
        lon: normalizedLongitude(waypoint.lon, 0),
        ...(typeof waypoint.ident === 'string' || typeof waypoint.icao === 'string'
          ? { ident: text(waypoint.ident) ?? text(waypoint.icao) ?? '' }
          : {}),
        ...(typeof waypoint.icao === 'string' ? { icao: waypoint.icao } : {}),
        ...(typeof waypoint.name === 'string' ? { name: waypoint.name } : {}),
      }))
    : plan?.waypoints.map(waypoint => ({ lat: waypoint.lat, lon: waypoint.lon, ident: waypoint.ident }));
  const completionRatio = finiteNumber(record.progress_pct)
    ?? (progress ? progress.completion_ratio * 100 : null);
  const remainingSeconds = progress?.estimated_time_remaining_sec ?? null;
  return {
    ...(text(record.route_id) || plan?.route_id || plan?.id
      ? { route_id: text(record.route_id) ?? plan?.route_id ?? plan?.id ?? '' }
      : {}),
    ...(text(record.status) || plan?.status ? { status: text(record.status) ?? plan?.status ?? 'active' } : {}),
    autopilot_engaged: booleanValue(record.autopilot_engaged) ?? plan?.autopilot_engaged ?? false,
    ...(text(record.origin_icao) || plan?.origin?.icao
      ? { origin_icao: text(record.origin_icao) ?? plan?.origin?.icao ?? '' }
      : {}),
    ...(text(record.destination_icao) || plan?.destination?.icao
      ? { destination_icao: text(record.destination_icao) ?? plan?.destination?.icao ?? '' }
      : {}),
    ...(completionRatio !== null ? { progress_pct: Math.min(100, Math.max(0, completionRatio)) } : {}),
    ...(normalizedRatioOrNull(record.progress) !== null
      ? { progress: normalizedRatioOrNull(record.progress) as number }
      : progress ? { progress: progress.completion_ratio } : {}),
    ...(finiteNumber(record.total_distance_nm) !== null || plan?.total_distance_nm != null
      ? { total_distance_nm: finiteNumber(record.total_distance_nm) ?? plan?.total_distance_nm ?? 0 }
      : {}),
    ...(finiteNumber(record.distance_flown_nm) !== null || progress
      ? { distance_flown_nm: finiteNumber(record.distance_flown_nm) ?? progress?.distance_flown_nm ?? 0 }
      : {}),
    ...(finiteNumber(record.distance_remaining_nm) !== null || progress
      ? { distance_remaining_nm: finiteNumber(record.distance_remaining_nm) ?? progress?.distance_remaining_nm ?? 0 }
      : {}),
    ...(finiteNumber(record.eta_minutes) !== null || remainingSeconds !== null
      ? { eta_minutes: finiteNumber(record.eta_minutes) ?? (remainingSeconds as number) / 60 }
      : {}),
    ...(Object.hasOwn(record, 'eta_seconds') || progress?.eta_seconds !== undefined
      ? { eta_seconds: nullableNumber(record.eta_seconds, progress?.eta_seconds ?? null) }
      : {}),
    ...(Object.hasOwn(record, 'wall_clock_eta_seconds') || progress?.wall_clock_eta_seconds !== undefined
      ? { wall_clock_eta_seconds: nullableNumber(record.wall_clock_eta_seconds, progress?.wall_clock_eta_seconds ?? null) }
      : {}),
    ...(finiteNumber(record.bearing_deg) !== null || progress?.bearing_deg !== undefined
      ? { bearing_deg: finiteNumber(record.bearing_deg) ?? progress?.bearing_deg ?? 0 }
      : {}),
    ...(finiteNumber(record.remaining_distance_nm) !== null || progress
      ? { remaining_distance_nm: finiteNumber(record.remaining_distance_nm) ?? progress?.distance_remaining_nm ?? 0 }
      : {}),
    ...(finiteNumber(record.cruise_altitude_ft) !== null || plan?.cruise_altitude_ft != null
      ? { cruise_altitude_ft: finiteNumber(record.cruise_altitude_ft) ?? plan?.cruise_altitude_ft ?? 0 }
      : {}),
    ...(finiteNumber(record.cruise_speed_kts) !== null || plan?.cruise_speed_kts != null
      ? { cruise_speed_kts: finiteNumber(record.cruise_speed_kts) ?? plan?.cruise_speed_kts ?? 0 }
      : {}),
    time_scale: numberOr(record.time_scale, plan?.time_scale ?? 1, 0),
    phase: stringOr(record.phase, plan?.phase ?? 'UNKNOWN'),
    ...(text(record.started_at) || plan?.started_at
      ? { started_at: text(record.started_at) ?? plan?.started_at ?? '' }
      : {}),
    diverted: booleanValue(record.diverted) ?? plan?.diverted ?? false,
    diversion_reason: nullableText(record.diversion_reason, plan?.diversion_reason ?? null),
    ...(rawWaypoints ? { waypoints: rawWaypoints } : {}),
    ...(normalizeRouteAirport(record.origin) ?? plan?.origin ?? null
      ? { origin: normalizeRouteAirport(record.origin) ?? plan?.origin ?? undefined }
      : {}),
    ...(normalizeRouteAirport(record.destination) ?? plan?.destination ?? null
      ? { destination: normalizeRouteAirport(record.destination) ?? plan?.destination ?? undefined }
      : {}),
    original_destination: record.original_destination === null
      ? null
      : normalizeRouteAirport(record.original_destination) ?? plan?.original_destination ?? null,
  };
}

function normalizeAction(value: UnknownRecord, index: number, emergencyId: string | null = null): EmergencyAction {
  const id = stringOr(value.id ?? value.action_id, `${emergencyId ?? 'action'}-${index + 1}`);
  const completed = booleanValue(value.completed) ?? value.status === 'completed';
  const label = stringOr(value.label ?? value.title, `Action ${index + 1}`);
  const description = stringOr(value.description ?? value.instruction ?? value.message, '');
  const required = booleanValue(value.required) ?? true;
  return {
    id,
    emergency_id: nullableText(value.emergency_id, emergencyId),
    category: stringOr(value.category, 'checklist'),
    label,
    description,
    priority: Math.max(0, integer(value.priority) ?? index + 1),
    status: completed ? 'completed' : stringOr(value.status, 'pending'),
    procedure_reference: nullableText(value.procedure_reference ?? value.reference),
    requires_confirmation: booleanValue(value.requires_confirmation) ?? required,
    created_at: nullableText(value.created_at),
    completed_at: nullableText(value.completed_at),
    action_id: id,
    title: label,
    instruction: description,
    rationale: stringOr(value.rationale, ''),
    required,
    completed,
  };
}

function normalizeActions(value: unknown, emergencyId: string | null = null): EmergencyAction[] {
  return recordList(value).map((action, index) => normalizeAction(action, index, emergencyId));
}

function normalizeEmergency(value: UnknownRecord, index: number): EmergencyState {
  const id = stringOr(value.id ?? value.emergency_id, `emergency-${index + 1}`);
  const actions = normalizeActions(value.actions, id);
  const status = stringOr(value.status, 'declared');
  const summary = stringOr(value.summary ?? value.description, '');
  const title = stringOr(value.title ?? value.name, 'Emergency');
  const resolutionCriteria = recordList(value.resolution_criteria).map((criterion, criterionIndex) => ({
    criterion_id: stringOr(criterion.criterion_id ?? criterion.id, `criterion-${criterionIndex + 1}`),
    description: stringOr(criterion.description, ''),
    satisfied: booleanValue(criterion.satisfied) ?? false,
  }));
  return {
    id,
    emergency_id: id,
    type: stringOr(value.type, 'unknown'),
    title,
    description: summary,
    severity: stringOr(value.severity, 'distress'),
    status,
    declared_at: nullableText(value.declared_at ?? value.created_at),
    updated_at: nullableText(value.updated_at),
    resolved_at: nullableText(value.resolved_at),
    squawk: nullableText(value.squawk),
    affected_systems: stringList(value.affected_systems),
    checklist_id: nullableText(value.checklist_id),
    action_ids: stringList(value.action_ids, actions.map(action => action.id)),
    actions,
    summary,
    alert_message: stringOr(value.alert_message, summary),
    recommended_diversion: normalizeAirport(value.recommended_diversion, null),
    resolution_criteria: resolutionCriteria,
    can_resolve: booleanValue(value.can_resolve) ?? resolutionCriteria.every(criterion => criterion.satisfied),
    active: status !== 'resolved',
    name: title,
    objective: summary,
    steps: actions.map(action => ({
      id: action.id,
      title: action.label,
      detail: action.description,
      priority: String(action.priority),
      completed: action.status === 'completed',
    })),
  };
}

function normalizeEmergencies(value: unknown, singular: unknown, fallback: EmergencyState[]): EmergencyState[] {
  if (Array.isArray(value)) return recordList(value).map(normalizeEmergency);
  if (isRecord(singular)) return [normalizeEmergency(singular, 0)];
  return fallback.map((emergency) => ({
    ...emergency,
    affected_systems: [...emergency.affected_systems],
    action_ids: [...emergency.action_ids],
    actions: emergency.actions.map(action => ({ ...action })),
  }));
}

function normalizeAdvisories(value: unknown, fallback: Advisory[]): Advisory[] {
  if (!Array.isArray(value)) return fallback.map(advisory => ({ ...advisory, action_ids: [...advisory.action_ids] }));
  return recordList(value).map((advisory, index) => {
    const id = stringOr(advisory.id ?? advisory.alert_id, `advisory-${index + 1}`);
    const type = stringOr(advisory.type ?? advisory.category, 'system');
    const message = stringOr(advisory.message ?? advisory.description ?? advisory.summary, '');
    return {
    id,
    type,
    severity: stringOr(advisory.severity, 'info'),
    title: stringOr(advisory.title, 'Advisory'),
    message,
    source: stringOr(advisory.source, 'backend'),
    created_at: nullableText(advisory.created_at),
    expires_at: nullableText(advisory.expires_at),
    acknowledged: booleanValue(advisory.acknowledged) ?? false,
    action_ids: stringList(advisory.action_ids),
    ...(Object.hasOwn(advisory, 'lat') ? { lat: nullableNumber(advisory.lat) } : {}),
    ...(Object.hasOwn(advisory, 'lon') ? { lon: nullableNumber(advisory.lon) } : {}),
    alert_id: id,
    category: type,
    requires_acknowledgement: booleanValue(advisory.requires_acknowledgement) ?? true,
    action: stringOr(advisory.action, message),
    summary: stringOr(advisory.summary, message),
    ...(Object.hasOwn(advisory, 'rationale')
      ? { rationale: Array.isArray(advisory.rationale) ? stringList(advisory.rationale) : stringOr(advisory.rationale, '') }
      : {}),
    ...(finiteNumber(advisory.confidence) !== null
      ? { confidence: Math.min(1, Math.max(0, finiteNumber(advisory.confidence) as number)) }
      : {}),
    sources: stringList(advisory.sources, ['Authoritative backend alert']),
  };
  });
}

function normalizeSchema(records: UnknownRecord[], fallback: SnapshotSchemaInfo): SnapshotSchemaInfo {
  const rawSchema = firstValue(records, ['schema']);
  const rawVersion = firstValue(records, ['schema_version', 'schemaVersion']);
  if (isRecord(rawSchema)) {
    return {
      name: stringOr(rawSchema.name, fallback.name),
      version: String(rawSchema.version ?? rawVersion ?? fallback.version),
    };
  }
  if (typeof rawSchema === 'string') {
    const separator = rawSchema.lastIndexOf('/');
    return separator > 0
      ? { name: rawSchema.slice(0, separator), version: rawSchema.slice(separator + 1) }
      : { name: fallback.name, version: rawSchema };
  }
  return rawVersion === undefined ? { ...fallback } : { name: fallback.name, version: String(rawVersion) };
}

function timestampFromString(value: unknown): { iso: string; epochMs: number } | null {
  if (typeof value !== 'string') return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? { iso: new Date(epochMs).toISOString(), epochMs } : null;
}

interface WireTimestamps {
  timestamps: SnapshotTimestamps;
  ordering: { kind: 'epoch' | 'monotonic'; value: number } | null;
}

function normalizeTimestamps(records: UnknownRecord[], receivedAtMs: number): WireTimestamps {
  const rawTimestamps = firstValue(records, ['timestamps']);
  const timestampsRecord = isRecord(rawTimestamps) ? rawTimestamps : {};
  const serverAtValue = timestampsRecord.server_at
    ?? timestampsRecord.server
    ?? firstValue(records, ['server_at', 'server_time', 'generated_at', 'timestamp']);
  const parsedServerAt = timestampFromString(serverAtValue);
  let serverEpochMs = finiteNumber(timestampsRecord.server_epoch_ms);
  let serverMonotonicMs = finiteNumber(timestampsRecord.server_monotonic_ms);
  const legacyServerTs = finiteNumber(firstValue(records, ['server_ts']));

  if (serverEpochMs === null && parsedServerAt) serverEpochMs = parsedServerAt.epochMs;
  if (legacyServerTs !== null && serverEpochMs === null && serverMonotonicMs === null) {
    if (legacyServerTs > 10_000_000_000) serverEpochMs = legacyServerTs;
    else if (legacyServerTs > 1_000_000_000) serverEpochMs = legacyServerTs * 1_000;
    else serverMonotonicMs = legacyServerTs * 1_000;
  }

  const simulatedAt = timestampFromString(
    timestampsRecord.simulated_at ?? firstValue(records, ['simulated_at', 'simulation_time', 'observed_at']),
  );
  const ordering = serverEpochMs !== null
    ? { kind: 'epoch' as const, value: serverEpochMs }
    : serverMonotonicMs !== null
      ? { kind: 'monotonic' as const, value: serverMonotonicMs }
      : null;

  return {
    timestamps: {
      server_at: parsedServerAt?.iso ?? null,
      server_epoch_ms: serverEpochMs,
      server_monotonic_ms: serverMonotonicMs,
      simulated_at: simulatedAt?.iso ?? null,
      received_at: new Date(receivedAtMs).toISOString(),
      received_at_ms: receivedAtMs,
    },
    ordering,
  };
}

function normalizeSource(records: UnknownRecord[], connected: boolean, activeScenario: string): SnapshotSourceInfo {
  const raw = firstValue(records, ['source']);
  if (isRecord(raw)) {
    return {
      type: stringOr(raw.type, 'unknown'),
      name: nullableText(raw.name),
      simulator: nullableText(raw.simulator),
      connected: booleanValue(raw.connected) ?? connected,
    };
  }
  if (typeof raw === 'string') {
    return { type: raw, name: null, simulator: null, connected };
  }
  return {
    type: activeScenario ? 'scenario' : connected ? 'simconnect' : 'demo',
    name: activeScenario || null,
    simulator: connected && !activeScenario ? 'MSFS/SimConnect' : null,
    connected,
  };
}

function normalizeIssues(value: unknown): DataQualityIssue[] {
  return recordList(value).map(issue => ({
    code: stringOr(issue.code, 'unknown'),
    message: stringOr(issue.message, ''),
    field: nullableText(issue.field),
    severity: stringOr(issue.severity, 'caution') as AdvisorySeverity,
  }));
}

function normalizeDataQuality(
  records: UnknownRecord[],
  timestamps: SnapshotTimestamps,
  receivedAtMs: number,
  state: UnknownRecord,
): DataQuality {
  const raw = firstValue(records, ['data_quality', 'quality']);
  const quality = isRecord(raw) ? raw : {};
  const essentialFields = ['lat', 'lon', 'altitude', 'heading_mag', 'ground_speed', 'phase'];
  const presentFields = essentialFields.filter(field => Object.hasOwn(state, field)).length;
  const derivedCompleteness = presentFields / essentialFields.length;
  const completeness = nullableNumber(quality.completeness, derivedCompleteness);
  const explicitAge = nullableNumber(quality.age_ms ?? state.data_age_ms);
  const latency = nullableNumber(
    quality.latency_ms,
    timestamps.server_epoch_ms === null ? null : Math.max(0, receivedAtMs - timestamps.server_epoch_ms),
  );
  const age = explicitAge ?? latency;
  const stale = booleanValue(quality.stale) ?? (age !== null && age > MAX_REASONABLE_DATA_AGE_MS);
  const issues = normalizeIssues(quality.issues);
  const status = stringOr(
    quality.status,
    stale ? 'stale' : issues.length > 0 || (completeness !== null && completeness < 0.8) ? 'degraded' : 'good',
  );
  return {
    status,
    score: nullableNumber(quality.score),
    stale,
    age_ms: age,
    latency_ms: latency,
    completeness,
    issues,
  };
}

function normalizeFieldQuality(records: UnknownRecord[], fallback: Record<string, string>): Record<string, string> {
  const raw = firstValue(records, ['data_quality', 'quality']);
  if (!isRecord(raw)) return { ...fallback };
  const result: Record<string, string> = {};
  const rawFields = isRecord(raw.fields) ? raw.fields : raw;
  for (const [field, value] of Object.entries(rawFields)) {
    if (typeof value === 'string') {
      result[field] = value;
    } else if (isRecord(value) && typeof value.status === 'string') {
      result[field] = value.status;
    }
  }
  return Object.keys(result).length > 0 ? result : { ...fallback };
}

function normalizeScenarioControl(
  value: unknown,
  fallback: ScenarioControlState,
  sessionId: string,
  sequence: number,
  observedAt: string,
): ScenarioControlState {
  if (!isRecord(value)) {
    return fallback.session_id === sessionId
      ? { ...fallback }
      : { session_id: sessionId, status: 'running', paused: false, time_scale: 1, simulation_time_seconds: 0, changed_at: observedAt, snapshot_sequence: sequence };
  }
  const paused = booleanValue(value.paused) ?? value.status === 'paused';
  return {
    session_id: stringOr(value.session_id, sessionId),
    status: paused ? 'paused' : 'running',
    paused,
    time_scale: numberOr(value.time_scale, fallback.time_scale, 0.25, 120),
    simulation_time_seconds: numberOr(value.simulation_time_seconds, fallback.simulation_time_seconds, 0),
    changed_at: stringOr(value.changed_at, observedAt),
    snapshot_sequence: Math.max(0, integer(value.snapshot_sequence) ?? sequence),
  };
}

interface WireIdentity {
  sessionId: string | null;
  sequence: number | null;
}

function readWireStateRevision(records: UnknownRecord[]): number | null {
  const parsed = integer(firstValue(records, ['state_revision', 'stateRevision']));
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function readWireIdentity(records: UnknownRecord[]): WireIdentity {
  const rawSession = firstValue(records, ['session_id', 'sessionId']);
  const rawSequence = firstValue(records, ['sequence', 'seq']);
  const parsedSequence = integer(rawSequence);
  return {
    sessionId: typeof rawSession === 'string' && rawSession.trim() !== '' ? rawSession : null,
    sequence: parsedSequence !== null && parsedSequence >= 0 ? parsedSequence : null,
  };
}

interface NormalizationContext {
  sessionId: string;
  sequence: number;
  receivedAtMs: number;
  resetState: boolean;
}

function normalizeSnapshot(
  unpacked: UnpackedPayload,
  previous: SimData,
  context: NormalizationContext,
): SimData {
  const base = context.resetState ? createDefaultSimData(context.sessionId) : previous;
  const { state, envelope, metadata } = unpacked;
  const records = [envelope, state, ...metadata];
  const activeScenario = stringOr(state.active_scenario, base.active_scenario);
  const connected = booleanValue(state.connected) ?? base.connected;
  const wireTimestamps = normalizeTimestamps(records, context.receivedAtMs);
  const sourceInfo = normalizeSource(records, connected, activeScenario);
  const quality = normalizeDataQuality(records, wireTimestamps.timestamps, context.receivedAtMs, state);
  const emergencyExplicitlyCleared = (Object.hasOwn(state, 'emergency') && state.emergency === null)
    || (Object.hasOwn(state, 'active_emergency') && state.active_emergency === null);
  const emergencies = emergencyExplicitlyCleared
    ? []
    : normalizeEmergencies(state.emergencies, state.emergency ?? state.active_emergency, base.emergencies);
  const explicitActions = normalizeActions(state.actions ?? state.emergency_actions);
  const nestedActions = emergencies.flatMap(emergency => emergency.actions);
  const actionsById = new Map<string, EmergencyAction>();
  for (const action of [...nestedActions, ...explicitActions]) actionsById.set(action.id, action);
  const actions = [...actionsById.values()].sort((left, right) => left.priority - right.priority);
  const explicitActiveEmergency = isRecord(state.active_emergency)
    ? normalizeEmergency(state.active_emergency, 0)
    : null;
  const activeEmergency = explicitActiveEmergency
    ?? emergencies.find(emergency => emergency.status !== 'resolved')
    ?? null;
  const emergencyActive = booleanValue(state.emergency_active)
    ?? (activeEmergency !== null || state.squawk === '7700');

  const routePlan = normalizeRoutePlan(state.route_plan ?? state.route, base.route_plan);
  const routeProgress = normalizeRouteProgress(state.route_progress ?? state.route, base.route_progress);
  const route = normalizeLegacyRoute(state.route, routePlan, routeProgress, base.route);
  const observedAt = nullableText(
    state.observed_at,
    wireTimestamps.timestamps.server_at ?? wireTimestamps.timestamps.received_at,
  ) ?? wireTimestamps.timestamps.received_at;
  const advisories = normalizeAdvisories(state.advisories ?? state.alerts, base.advisories);
  const scenarioControl = normalizeScenarioControl(state.scenario_control, base.scenario_control, context.sessionId, context.sequence, observedAt);
  const snapshot: SimData = {
    connected,
    altitude: numberOr(state.altitude, base.altitude),
    ground_speed: numberOr(state.ground_speed, base.ground_speed, 0),
    heading_mag: normalizedHeading(state.heading_mag, base.heading_mag),
    lat: numberOr(state.lat, base.lat, -90, 90),
    lon: normalizedLongitude(state.lon, base.lon),
    com1_active: numberOr(state.com1_active, base.com1_active, 0),
    com1_standby: numberOr(state.com1_standby, base.com1_standby, 0),
    squawk: stringOr(state.squawk, base.squawk),
    xpdr_mode: stringOr(state.xpdr_mode, base.xpdr_mode),
    xpdr_ident: booleanValue(state.xpdr_ident) ?? base.xpdr_ident,
    on_ground: booleanValue(state.on_ground) ?? base.on_ground,
    atc_id: stringOr(state.atc_id, base.atc_id),
    atc_flight_number: stringOr(state.atc_flight_number, base.atc_flight_number),
    phase: stringOr(state.phase, base.phase),
    phase_label: stringOr(state.phase_label, base.phase_label),
    vertical_rate: numberOr(state.vertical_rate, base.vertical_rate),
    callsign: stringOr(state.callsign, base.callsign),
    vertical_speed_fpm: numberOr(state.vertical_speed_fpm, base.vertical_speed_fpm),
    true_airspeed: numberOr(state.true_airspeed, base.true_airspeed, 0),
    fuel_kg: numberOr(state.fuel_kg, base.fuel_kg, 0),
    fuel_initial_kg: numberOr(state.fuel_initial_kg, base.fuel_initial_kg, 0),
    wind_dir: normalizedHeading(state.wind_dir, base.wind_dir),
    wind_kts: numberOr(state.wind_kts, base.wind_kts, 0),
    traffic: normalizeTraffic(state.traffic, base.traffic),
    conflicts: normalizeConflicts(state.conflicts, base.conflicts),
    weather: normalizeWeather(state.weather, base.weather),
    emergency_active: emergencyActive,
    active_scenario: activeScenario,
    nearest_airport: normalizeAirport(state.nearest_airport, base.nearest_airport),
    session_id: context.sessionId,
    sequence: context.sequence,
    state_revision: Math.max(0, integer(firstValue(records, ['state_revision', 'stateRevision'])) ?? base.state_revision),
    schema: normalizeSchema(records, base.schema ?? LEGACY_SCHEMA),
    timestamps: wireTimestamps.timestamps,
    source: sourceInfo.type,
    data_quality: normalizeFieldQuality(records, base.data_quality),
    source_info: sourceInfo,
    quality,
    scenario_control: scenarioControl,
    route_plan: routePlan,
    route_progress: routeProgress,
    advisories,
    emergencies,
    active_emergency: activeEmergency,
    emergency: activeEmergency,
    actions,
    alerts: advisories,
    recommendation: advisories[0] ?? null,
    route,
    observed_at: observedAt,
    data_age_ms: nullableNumber(state.data_age_ms, quality.age_ms ?? 0) ?? 0,
  };

  // Keep synonymous vertical-rate fields coherent during the backend migration.
  if (Object.hasOwn(state, 'vertical_speed_fpm') && !Object.hasOwn(state, 'vertical_rate')) {
    snapshot.vertical_rate = snapshot.vertical_speed_fpm;
  } else if (Object.hasOwn(state, 'vertical_rate') && !Object.hasOwn(state, 'vertical_speed_fpm')) {
    snapshot.vertical_speed_fpm = snapshot.vertical_rate;
  }

  return snapshot;
}

export interface SnapshotAcceptOptions {
  transport: SimTransport;
  /** Stable training-room scope used to prevent cross-room command cursors. */
  trainingSessionId?: string;
  receivedAtMs?: number;
  /** Revision captured when a REST resync was started, used to prevent races. */
  expectedRevision?: number;
}

export type SnapshotAcceptance =
  | {
      accepted: true;
      snapshot: SimData;
      sessionChanged: boolean;
      transport: SimTransport;
      revision: number;
    }
  | {
      accepted: false;
      reason: SnapshotRejectionReason;
      transport: SimTransport;
      revision: number;
    };

/** Stateful ordering gate shared by polling and WebSocket hooks. */
export class SimSnapshotGate {
  private snapshot: SimData;
  private revision = 0;
  private localSequence = 0;
  private wireSessionId: string | null = null;
  private wireSequence: number | null = null;
  private ordering: { kind: 'epoch' | 'monotonic'; value: number } | null = null;
  private legacySessionGeneration = 0;

  constructor(initial?: SimData) {
    this.snapshot = initial ?? createDefaultSimData();
    this.localSequence = this.snapshot.sequence;
  }

  get current(): SimData {
    return this.snapshot;
  }

  get currentRevision(): number {
    return this.revision;
  }

  /**
   * A legacy backend has no session id, so a server restart can reset its
   * monotonic clock. Clear only legacy ordering at a new transport epoch while
   * retaining authoritative sequence/session gates for versioned backends.
   */
  beginTransportEpoch(): void {
    if (this.wireSessionId === null) {
      this.wireSequence = null;
      this.ordering = null;
    }
  }

  reset(sessionId?: string): SimData {
    clearAcceptedCommandContext();
    this.legacySessionGeneration += 1;
    const nextSessionId = sessionId?.trim() || `legacy:${this.legacySessionGeneration}`;
    this.snapshot = createDefaultSimData(nextSessionId);
    this.revision += 1;
    this.localSequence = 0;
    this.wireSessionId = sessionId?.trim() || null;
    this.wireSequence = null;
    this.ordering = null;
    return this.snapshot;
  }

  accept(payload: unknown, options: SnapshotAcceptOptions): SnapshotAcceptance {
    const unpacked = unpackPayload(payload);
    if (!unpacked) {
      return { accepted: false, reason: 'invalid', transport: options.transport, revision: this.revision };
    }

    const records = [unpacked.envelope, unpacked.state, ...unpacked.metadata];
    const schemaVersion = checkSchemaVersion(records);
    if (!schemaVersion.compatible) {
      clearAcceptedCommandContext();
      return { accepted: false, reason: schemaVersion.reason, transport: options.transport, revision: this.revision };
    }
    const identity = readWireIdentity(records);
    const stateRevision = readWireStateRevision(records);
    const receivedAtMs = options.receivedAtMs ?? Date.now();
    const timestamps = normalizeTimestamps(records, receivedAtMs);
    let sessionChanged = false;

    if (identity.sessionId !== null && identity.sessionId !== this.wireSessionId) {
      sessionChanged = this.revision > 0;
      this.wireSessionId = identity.sessionId;
      this.wireSequence = null;
      this.ordering = null;
      this.localSequence = 0;
    }

    if (!sessionChanged && identity.sequence !== null && this.wireSequence !== null) {
      if (identity.sequence === this.wireSequence) {
        return { accepted: false, reason: 'duplicate', transport: options.transport, revision: this.revision };
      }
      if (identity.sequence < this.wireSequence) {
        return { accepted: false, reason: 'out_of_order', transport: options.transport, revision: this.revision };
      }
    }

    if (
      !sessionChanged
      && identity.sequence === null
      && timestamps.ordering !== null
      && this.ordering !== null
      && timestamps.ordering.kind === this.ordering.kind
    ) {
      if (timestamps.ordering.value === this.ordering.value) {
        return { accepted: false, reason: 'duplicate', transport: options.transport, revision: this.revision };
      }
      if (timestamps.ordering.value < this.ordering.value) {
        return { accepted: false, reason: 'stale', transport: options.transport, revision: this.revision };
      }
    }

    const hasOrdering = identity.sequence !== null || timestamps.ordering !== null;
    if (
      !sessionChanged
      && options.expectedRevision !== undefined
      && this.revision > options.expectedRevision
      && !hasOrdering
    ) {
      return { accepted: false, reason: 'superseded', transport: options.transport, revision: this.revision };
    }

    if (identity.sequence !== null) this.wireSequence = identity.sequence;
    if (timestamps.ordering !== null) this.ordering = timestamps.ordering;
    this.localSequence = identity.sequence ?? this.localSequence + 1;
    const sessionId = identity.sessionId ?? this.snapshot.session_id;
    this.snapshot = normalizeSnapshot(unpacked, this.snapshot, {
      sessionId,
      sequence: this.localSequence,
      receivedAtMs,
      resetState: sessionChanged,
    });
    if (stateRevision === null) {
      clearAcceptedCommandContext();
    } else {
      updateAcceptedCommandContext({
        trainingSessionId: options.trainingSessionId?.trim() || null,
        runtimeSessionId: this.snapshot.session_id,
        sequence: this.snapshot.sequence,
        stateRevision: this.snapshot.state_revision,
      });
    }
    this.revision += 1;

    return {
      accepted: true,
      snapshot: this.snapshot,
      sessionChanged,
      transport: options.transport,
      revision: this.revision,
    };
  }
}

export type SessionInvalidationReason = 'reset' | 'scenario' | 'custom-scenario' | 'external';

export interface SessionInvalidation {
  generation: number;
  reason: SessionInvalidationReason;
  session_id: string | null;
  occurred_at: string;
}

type SessionInvalidationListener = (event: SessionInvalidation) => void;
const sessionListeners = new Set<SessionInvalidationListener>();
let sessionGeneration = 0;

/** Notify all mounted state hooks after a mutating API call changes the session. */
export function invalidateSimSession(reason: SessionInvalidationReason, sessionId?: string | null): void {
  sessionGeneration += 1;
  const event: SessionInvalidation = {
    generation: sessionGeneration,
    reason,
    session_id: sessionId?.trim() || null,
    occurred_at: new Date().toISOString(),
  };
  for (const listener of sessionListeners) listener(event);
}

export function subscribeToSimSessionInvalidation(listener: SessionInvalidationListener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** Runtime check used at the API boundary before a payload reaches the gate. */
export function isSimSnapshotPayload(value: unknown): value is SimSnapshotPayload {
  return isRecord(value);
}
