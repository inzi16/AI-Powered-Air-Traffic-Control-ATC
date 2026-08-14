/**
 * Canonical frontend contracts for simulation state.
 *
 * The backend currently sends a flat, unversioned object.  The wire contracts
 * below also support an enriched envelope so the backend can evolve without a
 * flag-day migration of existing UI components.
 */

export type ExtensibleString<T extends string> = T | (string & {});

export type FlightPhase = ExtensibleString<
  | 'UNKNOWN'
  | 'AT_GATE'
  | 'PUSHBACK'
  | 'TAXI'
  | 'HOLDING_SHORT'
  | 'TAKEOFF'
  | 'INITIAL_CLIMB'
  | 'CLIMB'
  | 'CRUISE'
  | 'DESCENT'
  | 'APPROACH'
  | 'FINAL_APPROACH'
  | 'LANDED'
  | 'EMERGENCY'
>;

export interface TrafficContact {
  callsign: string;
  type: string;
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  speed: number;
  squawk: string;
  on_ground: boolean;
  range_nm: number;
  bearing: number;
}

export interface ConflictAlert {
  callsign: string;
  range_nm: number;
  alt_diff_ft: number;
  bearing: number;
  severity?: ExtensibleString<'traffic' | 'resolution'>;
  time_to_closest_approach_sec?: number | null;
  conflict_id?: string;
  current_range_nm?: number;
  current_vertical_separation_ft?: number;
  bearing_deg?: number;
  closing_rate_kts?: number;
  time_to_cpa_seconds?: number;
  cpa_distance_nm?: number;
  cpa_vertical_separation_ft?: number;
  lookahead_seconds?: number;
  advisory?: string;
  /** Compatibility aliases used by the current radar revamp. */
  time_to_cpa_s?: number;
  cpa_vertical_ft?: number;
}

export interface WeatherData {
  wind_dir: number;
  wind_kts: number;
  gust_kts: number;
  visibility_km: number;
  ceiling_ft: number | null;
  qnh_hpa: number;
  temp_c: number;
  dewpoint_c: number;
}

export interface AirportReference {
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  distance_nm: number;
  elev: number;
  rwys: string[];
  freq: Record<string, number>;
}

export interface RouteAirport {
  icao: string;
  iata?: string | null;
  name?: string | null;
  lat: number;
  lon: number;
  elevation_ft?: number | null;
  runway?: string | null;
  catalog_source?: string | null;
}

export type AltitudeConstraintType = ExtensibleString<'at' | 'at_or_above' | 'at_or_below' | 'between'>;

export interface RouteWaypoint {
  id: string;
  ident: string;
  name?: string | null;
  type: ExtensibleString<'airport' | 'fix' | 'vor' | 'ndb' | 'user' | 'runway'>;
  lat: number;
  lon: number;
  altitude_ft?: number | null;
  altitude_constraint?: {
    type: AltitudeConstraintType;
    minimum_ft?: number | null;
    maximum_ft?: number | null;
  } | null;
  speed_constraint_kts?: number | null;
  airway?: string | null;
}

export interface RoutePlan {
  id: string;
  route_id?: string;
  revision: number;
  status: ExtensibleString<'draft' | 'filed' | 'active' | 'diverting' | 'completed' | 'cancelled'>;
  origin: RouteAirport | null;
  destination: RouteAirport | null;
  alternate: RouteAirport | null;
  departure_procedure: string | null;
  arrival_procedure: string | null;
  approach: string | null;
  cruise_altitude_ft: number | null;
  cruise_speed_kts: number | null;
  total_distance_nm: number | null;
  estimated_duration_sec: number | null;
  waypoints: RouteWaypoint[];
  created_at: string | null;
  updated_at: string | null;
  autopilot_engaged?: boolean;
  original_destination?: RouteAirport | null;
  time_scale?: number;
  phase?: string;
  started_at?: string | null;
  diverted?: boolean;
  diversion_reason?: string | null;
}

export interface RouteProgress {
  route_id: string | null;
  active_leg_index: number;
  previous_waypoint_id: string | null;
  next_waypoint_id: string | null;
  distance_flown_nm: number;
  distance_remaining_nm: number;
  leg_distance_remaining_nm: number | null;
  cross_track_error_nm: number | null;
  track_error_deg: number | null;
  completion_ratio: number;
  eta: string | null;
  estimated_time_remaining_sec: number | null;
  on_route: boolean;
  last_waypoint_passed_at: string | null;
  bearing_deg?: number | null;
  eta_seconds?: number | null;
  wall_clock_eta_seconds?: number | null;
  status?: string;
  autopilot_engaged?: boolean;
  time_scale?: number;
  phase?: string;
  diverted?: boolean;
  diversion_reason?: string | null;
}

/** Transitional route summary understood by the current revamp components. */
export interface LegacyRouteSummary {
  route_id?: string;
  status?: string;
  autopilot_engaged?: boolean;
  origin_icao?: string;
  destination_icao?: string;
  origin?: RouteAirport;
  destination?: RouteAirport;
  original_destination?: RouteAirport | null;
  progress_pct?: number;
  progress?: number;
  total_distance_nm?: number;
  distance_flown_nm?: number;
  distance_remaining_nm?: number;
  remaining_distance_nm?: number;
  eta_minutes?: number;
  eta_seconds?: number | null;
  wall_clock_eta_seconds?: number | null;
  bearing_deg?: number;
  cruise_altitude_ft?: number;
  cruise_speed_kts?: number;
  time_scale?: number;
  phase?: string;
  started_at?: string;
  diverted?: boolean;
  diversion_reason?: string | null;
  waypoints?: Array<{ lat: number; lon: number; ident?: string; icao?: string; name?: string }>;
}

export type AdvisorySeverity = ExtensibleString<'info' | 'caution' | 'warning' | 'critical'>;

export interface Advisory {
  id: string;
  type: ExtensibleString<
    | 'traffic'
    | 'terrain'
    | 'weather'
    | 'fuel'
    | 'route'
    | 'altitude'
    | 'speed'
    | 'airspace'
    | 'system'
  >;
  severity: AdvisorySeverity;
  title: string;
  message: string;
  source: string;
  created_at: string | null;
  expires_at: string | null;
  acknowledged: boolean;
  action_ids: string[];
  lat?: number | null;
  lon?: number | null;
  alert_id?: string;
  category?: string;
  requires_acknowledgement?: boolean;
  action?: string;
  summary?: string;
  rationale?: string[] | string;
  confidence?: number;
  sources?: string[];
  alternatives?: Array<{ title?: string; action?: string }>;
}

export type EmergencySeverity = ExtensibleString<'advisory' | 'urgent' | 'distress' | 'catastrophic'>;
export type EmergencyStatus = ExtensibleString<'detected' | 'declared' | 'responding' | 'stabilized' | 'resolved'>;
export type EmergencyActionStatus = ExtensibleString<'pending' | 'in_progress' | 'completed' | 'skipped' | 'blocked'>;

export interface EmergencyAction {
  id: string;
  emergency_id: string | null;
  category: ExtensibleString<'aviate' | 'navigate' | 'communicate' | 'checklist' | 'coordinate' | 'land'>;
  label: string;
  description: string;
  priority: number;
  status: EmergencyActionStatus;
  procedure_reference: string | null;
  requires_confirmation: boolean;
  created_at: string | null;
  completed_at: string | null;
  action_id?: string;
  title?: string;
  instruction?: string;
  rationale?: string;
  required?: boolean;
  completed?: boolean;
}

export interface ResolutionCriterion {
  criterion_id: string;
  description: string;
  satisfied: boolean;
}

export interface EmergencyState {
  id: string;
  emergency_id?: string;
  type: string;
  title: string;
  description: string;
  severity: EmergencySeverity;
  status: EmergencyStatus;
  declared_at: string | null;
  updated_at: string | null;
  resolved_at: string | null;
  squawk: string | null;
  affected_systems: string[];
  checklist_id: string | null;
  action_ids: string[];
  actions: EmergencyAction[];
  summary?: string;
  alert_message?: string;
  recommended_diversion?: AirportReference | null;
  resolution_criteria?: ResolutionCriterion[];
  can_resolve?: boolean;
  /** Compatibility coaching aliases for the current UI revamp. */
  active?: boolean;
  name?: string;
  objective?: string;
  steps?: Array<{
    id: string;
    title: string;
    detail?: string;
    priority?: string;
    completed?: boolean;
  }>;
}

export interface SnapshotSchemaInfo {
  name: string;
  version: string;
}

export type SnapshotSourceType = ExtensibleString<'simconnect' | 'demo' | 'scenario' | 'replay' | 'synthetic' | 'unknown'>;

export interface SnapshotSourceInfo {
  type: SnapshotSourceType;
  name: string | null;
  simulator: string | null;
  connected: boolean;
}

export interface SnapshotTimestamps {
  /** ISO-8601 timestamp generated by the backend, when available. */
  server_at: string | null;
  /** Epoch time is kept separate from monotonic server time. */
  server_epoch_ms: number | null;
  server_monotonic_ms: number | null;
  simulated_at: string | null;
  received_at: string;
  received_at_ms: number;
}

export interface DataQualityIssue {
  code: string;
  message: string;
  field: string | null;
  severity: AdvisorySeverity;
}

export interface DataQuality {
  status: ExtensibleString<'good' | 'degraded' | 'stale' | 'invalid' | 'unknown'>;
  score: number | null;
  stale: boolean;
  age_ms: number | null;
  latency_ms: number | null;
  completeness: number | null;
  issues: DataQualityIssue[];
}

export interface ScenarioControlState {
  session_id: string;
  status: 'running' | 'paused';
  paused: boolean;
  time_scale: number;
  simulation_time_seconds: number;
  changed_at: string;
  snapshot_sequence: number;
}

/** Fields consumed by the existing UI plus the richer production model. */
export interface SimData {
  // Legacy aircraft/simulator fields. These remain required after normalization.
  connected: boolean;
  altitude: number;
  ground_speed: number;
  heading_mag: number;
  lat: number;
  lon: number;
  com1_active: number;
  com1_standby: number;
  squawk: string;
  xpdr_mode: string;
  xpdr_ident: boolean;
  on_ground: boolean;
  atc_id: string;
  atc_flight_number: string;
  phase: FlightPhase;
  phase_label: string;
  vertical_rate: number;
  callsign: string;
  vertical_speed_fpm: number;
  true_airspeed: number;
  fuel_kg: number;
  fuel_initial_kg: number;
  wind_dir: number;
  wind_kts: number;
  traffic: TrafficContact[];
  conflicts: ConflictAlert[];
  weather: WeatherData | null;
  emergency_active: boolean;
  active_scenario: string;
  nearest_airport: AirportReference | null;

  // Versioned snapshot identity and provenance.
  session_id: string;
  sequence: number;
  state_revision: number;
  schema: SnapshotSchemaInfo;
  timestamps: SnapshotTimestamps;
  /** Compact aliases retained for components migrating from the legacy model. */
  source: string;
  data_quality: Record<string, string>;
  source_info: SnapshotSourceInfo;
  quality: DataQuality;
  scenario_control: ScenarioControlState;

  // Navigation, operational awareness, and emergency response.
  route_plan: RoutePlan | null;
  route_progress: RouteProgress | null;
  advisories: Advisory[];
  emergencies: EmergencyState[];
  active_emergency: EmergencyState | null;
  emergency: EmergencyState | null;
  actions: EmergencyAction[];
  alerts: Advisory[];
  recommendation: Advisory | null;

  // Compatibility aliases for UI modules that are migrating incrementally.
  route: LegacyRouteSummary | null;
  observed_at?: string;
  data_age_ms?: number;
}

/**
 * Accepted wire shape. All fields are optional because older backend versions
 * send a flat partial state, while newer versions may nest it under state/data.
 * Runtime normalization in state/simState.ts is the trust boundary.
 */
export type SimStatePatch = Partial<Omit<SimData, 'source' | 'data_quality'>> & {
  source?: SnapshotSourceInfo | SnapshotSourceType;
  data_quality?: Partial<DataQuality> | Record<string, string>;
};

export interface SimSnapshotEnvelope {
  session_id?: string;
  sessionId?: string;
  sequence?: number;
  seq?: number;
  state_revision?: number;
  schema?: SnapshotSchemaInfo | string;
  schema_version?: string | number;
  timestamps?: Partial<SnapshotTimestamps>;
  source?: SnapshotSourceInfo | SnapshotSourceType;
  data_quality?: Partial<DataQuality> | Record<string, string>;
  metadata?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  state?: SimStatePatch;
  data?: SimStatePatch | { state?: SimStatePatch };
  snapshot?: SimSnapshotPayload;
  server_ts?: number;
}

export type SimSnapshotPayload = SimStatePatch & SimSnapshotEnvelope;

export type SimTransport = 'websocket' | 'polling' | 'none';
export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'degraded' | 'reconnecting' | 'offline';

export interface ConnectionErrorInfo {
  code: string;
  message: string;
  status: number | null;
  retryable: boolean;
  occurred_at: string;
}

export interface ConnectionMetadata {
  status: ConnectionStatus;
  transport: SimTransport;
  backend_online: boolean;
  reconnecting: boolean;
  attempt: number;
  connected_at: string | null;
  disconnected_at: string | null;
  last_message_at: string | null;
  last_message_at_ms: number | null;
  next_retry_at: string | null;
  last_error: ConnectionErrorInfo | null;
  rejected_snapshots: number;
  last_rejection_reason: SnapshotRejectionReason | null;
  schema_compatible: boolean;
  schema_error: string | null;
}

export type SnapshotRejectionReason =
  | 'invalid'
  | 'schema_version_invalid'
  | 'schema_version_incompatible'
  | 'duplicate'
  | 'out_of_order'
  | 'stale'
  | 'superseded';

export interface SimHookMetadata {
  backendOnline: boolean;
  reconnecting: boolean;
  connection: ConnectionMetadata;
  dataAgeMs: number | null;
  dataStale: boolean;
  lastUpdatedAt: string | null;
  resync: () => Promise<void>;
}

export type SimHookResult = SimData & SimHookMetadata;

const DEFAULT_RECEIVED_AT = '1970-01-01T00:00:00.000Z';

export function createDefaultSimData(sessionId = 'legacy'): SimData {
  return {
    connected: false,
    altitude: 0,
    ground_speed: 0,
    heading_mag: 0,
    lat: 0,
    lon: 0,
    com1_active: 0,
    com1_standby: 0,
    squawk: '----',
    xpdr_mode: '',
    xpdr_ident: false,
    on_ground: true,
    atc_id: '',
    atc_flight_number: '',
    phase: 'UNKNOWN',
    phase_label: 'Unknown',
    vertical_rate: 0,
    callsign: '',
    vertical_speed_fpm: 0,
    true_airspeed: 0,
    fuel_kg: 0,
    fuel_initial_kg: 0,
    wind_dir: 0,
    wind_kts: 0,
    traffic: [],
    conflicts: [],
    weather: null,
    emergency_active: false,
    active_scenario: '',
    nearest_airport: null,
    session_id: sessionId,
    sequence: 0,
    state_revision: 0,
    schema: { name: 'atc.sim.snapshot', version: 'legacy' },
    timestamps: {
      server_at: null,
      server_epoch_ms: null,
      server_monotonic_ms: null,
      simulated_at: null,
      received_at: DEFAULT_RECEIVED_AT,
      received_at_ms: 0,
    },
    source: 'unknown',
    data_quality: {},
    source_info: { type: 'unknown', name: null, simulator: null, connected: false },
    quality: {
      status: 'unknown',
      score: null,
      stale: true,
      age_ms: null,
      latency_ms: null,
      completeness: null,
      issues: [],
    },
    scenario_control: {
      session_id: sessionId,
      status: 'running',
      paused: false,
      time_scale: 1,
      simulation_time_seconds: 0,
      changed_at: DEFAULT_RECEIVED_AT,
      snapshot_sequence: 0,
    },
    route_plan: null,
    route_progress: null,
    advisories: [],
    emergencies: [],
    active_emergency: null,
    emergency: null,
    actions: [],
    alerts: [],
    recommendation: null,
    route: null,
  };
}

export function createInitialConnectionMetadata(transport: SimTransport): ConnectionMetadata {
  return {
    status: 'idle',
    transport,
    backend_online: false,
    reconnecting: false,
    attempt: 0,
    connected_at: null,
    disconnected_at: null,
    last_message_at: null,
    last_message_at_ms: null,
    next_retry_at: null,
    last_error: null,
    rejected_snapshots: 0,
    last_rejection_reason: null,
    schema_compatible: true,
    schema_error: null,
  };
}
