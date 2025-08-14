import {
  invalidateSimSession,
  isSimSnapshotPayload,
} from './state/simState';
import type {
  AirportReference,
  ConnectionErrorInfo,
  SimSnapshotPayload,
  SimStatePatch,
} from './types/sim';

const DEFAULT_TIMEOUT_MS = 12_000;
const MEDIA_TIMEOUT_MS = 45_000;
const AI_TIMEOUT_MS = 45_000;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.replace(/\/+$/, '');
}

/**
 * One base URL is used for both REST and WebSocket endpoints. In development
 * it defaults to Vite's same-origin /api proxy; deployments can set
 * VITE_API_BASE to an absolute URL or another path prefix.
 */
export const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE || '/api');

export function resolveApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}` || normalizedPath;
}

export function resolveWebSocketUrl(path = '/ws/state'): string {
  const explicitUrl = import.meta.env.VITE_WS_URL?.trim();
  const endpoint = explicitUrl || resolveApiUrl(path);
  const fallbackOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const url = new URL(endpoint, fallbackOrigin);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString();
}

export const SIM_STATE_WS_URL = resolveWebSocketUrl('/ws/state');

export type ApiErrorCode =
  | 'ABORTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'API_ERROR'
  | 'INVALID_RESPONSE';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  readonly url: string;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    code: ApiErrorCode;
    status?: number | null;
    url: string;
    details?: unknown;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status ?? null;
    this.url = options.url;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (typeof payload !== 'object' || payload === null) return fallback;
  const record = payload as Record<string, unknown>;
  for (const key of ['error', 'message', 'detail']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function requestWithResponse<T>(
  path: string,
  consume: (response: Response) => Promise<T>,
  init: RequestInit = {},
  options: ApiRequestOptions = {},
): Promise<T> {
  const url = resolveApiUrl(path);
  const controller = new AbortController();
  const upstreamSignal = options.signal ?? init.signal;
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });

  const timeoutId = timeoutMs > 0
    ? window.setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('Request timed out', 'TimeoutError'));
      }, timeoutMs)
    : null;

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      credentials: init.credentials ?? 'same-origin',
    });
    if (!response.ok) {
      const details = await parseResponseBody(response);
      throw new ApiError({
        message: errorMessage(details, `Request failed with HTTP ${response.status}`),
        code: 'HTTP_ERROR',
        status: response.status,
        url,
        details,
        retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
      });
    }
    return await consume(response);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError({
        message: timedOut ? `Request timed out after ${timeoutMs} ms` : 'Request was cancelled',
        code: timedOut ? 'TIMEOUT' : 'ABORTED',
        url,
        retryable: timedOut,
        cause: error,
      });
    }
    throw new ApiError({
      message: error instanceof Error ? error.message : 'Network request failed',
      code: 'NETWORK_ERROR',
      url,
      retryable: true,
      cause: error,
    });
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

async function requestJson(
  path: string,
  init: RequestInit = {},
  options: ApiRequestOptions = {},
): Promise<unknown> {
  const payload = await requestWithResponse(path, parseResponseBody, init, options);
  if (typeof payload === 'object' && payload !== null) {
    const applicationError = (payload as Record<string, unknown>).error;
    if (typeof applicationError === 'string' && applicationError.trim()) {
      throw new ApiError({
        message: applicationError,
        code: 'API_ERROR',
        status: 200,
        url: resolveApiUrl(path),
        details: payload,
        retryable: false,
      });
    }
  }
  return payload;
}

interface EventEnvelopeRecord {
  event: Record<string, unknown> | null;
  data: Record<string, unknown>;
}

function unwrapEventEnvelope(record: Record<string, unknown>): EventEnvelopeRecord {
  const event = typeof record.event === 'object' && record.event !== null && !Array.isArray(record.event)
    ? record.event as Record<string, unknown>
    : null;
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record;
  return { event, data };
}

function requireRecord(payload: unknown, path: string): Record<string, unknown> {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  throw new ApiError({
    message: 'Backend returned an invalid JSON object',
    code: 'INVALID_RESPONSE',
    url: resolveApiUrl(path),
    details: payload,
  });
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function toConnectionErrorInfo(error: unknown): ConnectionErrorInfo {
  const occurredAt = new Date().toISOString();
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      occurred_at: occurredAt,
    };
  }
  return {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : 'Unknown connection error',
    status: null,
    retryable: true,
    occurred_at: occurredAt,
  };
}

export async function fetchSimState(options: ApiRequestOptions = {}): Promise<SimSnapshotPayload> {
  const payload = await requestJson('/sim/state', {}, options);
  if (!isSimSnapshotPayload(payload)) {
    throw new ApiError({
      message: 'Simulation snapshot was not an object',
      code: 'INVALID_RESPONSE',
      url: resolveApiUrl('/sim/state'),
      details: payload,
    });
  }
  return payload;
}

export interface FlightPhaseInfo {
  phase: string;
  phase_label: string;
  vertical_rate: number;
}

export interface ChatResponse {
  reply: string;
  confidence?: number;
  flight_state: SimStatePatch | null;
  phase: Partial<FlightPhaseInfo> | null;
  nearest_airport: AirportReference | null;
  callsign: string;
  session_id?: string;
  sequence?: number;
  clearance?: {
    clearance_id: string;
    status?: string;
    raw_text?: string;
  } | null;
  requires_acceptance?: boolean;
}

export async function sendChat(message: string, options: ApiRequestOptions = {}): Promise<ChatResponse> {
  const path = '/chat';
  const record = requireRecord(await requestJson(path, jsonPost({ message }), options), path);
  if (typeof record.reply !== 'string') {
    throw new ApiError({
      message: 'Chat response is missing a reply',
      code: 'INVALID_RESPONSE',
      url: resolveApiUrl(path),
      details: record,
    });
  }
  return {
    reply: record.reply,
    ...(typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? { confidence: Math.min(1, Math.max(0, record.confidence)) }
      : {}),
    flight_state: isSimSnapshotPayload(record.flight_state) ? record.flight_state : null,
    phase: typeof record.phase === 'object' && record.phase !== null
      ? record.phase as Partial<FlightPhaseInfo>
      : null,
    nearest_airport: typeof record.nearest_airport === 'object' && record.nearest_airport !== null
      ? record.nearest_airport as AirportReference
      : null,
    callsign: typeof record.callsign === 'string' ? record.callsign : '',
    ...(typeof record.session_id === 'string' ? { session_id: record.session_id } : {}),
    ...(typeof record.sequence === 'number' ? { sequence: record.sequence } : {}),
    clearance: typeof record.clearance === 'object' && record.clearance !== null
      ? record.clearance as ChatResponse['clearance']
      : null,
    requires_acceptance: record.requires_acceptance === true,
  };
}

export interface CallsignResponse {
  callsign: string;
}

export async function setCallsign(callsign: string, options: ApiRequestOptions = {}): Promise<CallsignResponse> {
  const path = '/callsign';
  const record = requireRecord(await requestJson(path, jsonPost({ callsign }), options), path);
  const { data } = unwrapEventEnvelope(record);
  return { callsign: typeof data.callsign === 'string' ? data.callsign : callsign };
}

export async function fetchTTS(text: string, voice?: string, options: ApiRequestOptions = {}): Promise<Blob> {
  return requestWithResponse('/tts', response => response.blob(), jsonPost({ text, voice }), {
    ...options,
    timeoutMs: options.timeoutMs ?? MEDIA_TIMEOUT_MS,
  });
}

export async function sendSTT(blob: Blob, options: ApiRequestOptions = {}): Promise<string> {
  const form = new FormData();
  form.append('audio', blob, 'audio.webm');
  const path = '/stt';
  const record = requireRecord(await requestJson(path, { method: 'POST', body: form }, {
    ...options,
    timeoutMs: options.timeoutMs ?? MEDIA_TIMEOUT_MS,
  }), path);
  if (typeof record.text !== 'string') {
    throw new ApiError({
      message: 'Speech-to-text response is missing text',
      code: 'INVALID_RESPONSE',
      url: resolveApiUrl(path),
      details: record,
    });
  }
  return record.text;
}

export interface ScenarioSummary {
  name: string;
  description: string;
}

export type ScenarioListResponse = Record<string, ScenarioSummary>;

export async function fetchScenarios(options: ApiRequestOptions = {}): Promise<ScenarioListResponse> {
  const path = '/scenarios';
  const record = requireRecord(await requestJson(path, {}, options), path);
  const scenarios: ScenarioListResponse = {};
  for (const [id, value] of Object.entries(record)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const scenario = value as Record<string, unknown>;
    if (typeof scenario.name !== 'string' || typeof scenario.description !== 'string') continue;
    scenarios[id] = { name: scenario.name, description: scenario.description };
  }
  return scenarios;
}

export interface ScenarioResponse {
  scenario: string;
  state: SimStatePatch | null;
  phase: Partial<FlightPhaseInfo> | null;
  nearest_airport: AirportReference | null;
  initial_message: string;
  atc_reply: string;
  generated_data?: Record<string, unknown>;
  session_id?: string;
}

function parseScenarioResponse(payload: unknown, path: string): ScenarioResponse {
  const outerRecord = requireRecord(payload, path);
  const { event, data: record } = unwrapEventEnvelope(outerRecord);
  const eventSessionId = event && typeof event.session_id === 'string' ? event.session_id : undefined;
  return {
    scenario: typeof record.scenario === 'string' ? record.scenario : '',
    state: isSimSnapshotPayload(record.state) ? record.state : null,
    phase: typeof record.phase === 'object' && record.phase !== null
      ? record.phase as Partial<FlightPhaseInfo>
      : null,
    nearest_airport: typeof record.nearest_airport === 'object' && record.nearest_airport !== null
      ? record.nearest_airport as AirportReference
      : null,
    initial_message: typeof record.initial_message === 'string' ? record.initial_message : '',
    atc_reply: typeof record.atc_reply === 'string' ? record.atc_reply : '',
    ...(typeof record.generated_data === 'object' && record.generated_data !== null && !Array.isArray(record.generated_data)
      ? { generated_data: record.generated_data as Record<string, unknown> }
      : {}),
    ...(typeof record.session_id === 'string'
      ? { session_id: record.session_id }
      : eventSessionId ? { session_id: eventSessionId } : {}),
  };
}

export async function loadScenario(
  scenarioId: string,
  customMessage?: string,
  options: ApiRequestOptions = {},
): Promise<ScenarioResponse> {
  const path = '/scenario/load';
  const response = parseScenarioResponse(await requestJson(path, jsonPost({
    scenario_id: scenarioId,
    custom_message: customMessage,
  }), options), path);
  invalidateSimSession('scenario', response.session_id);
  return response;
}

export async function createCustomScenario(
  description: string,
  options: ApiRequestOptions = {},
): Promise<ScenarioResponse> {
  const path = '/scenario/custom';
  const response = parseScenarioResponse(await requestJson(path, jsonPost({ description }), {
    ...options,
    timeoutMs: options.timeoutMs ?? AI_TIMEOUT_MS,
  }), path);
  invalidateSimSession('custom-scenario', response.session_id);
  return response;
}

export interface StatusResponse {
  status: string;
  session_id?: string;
}

export async function resetSession(options: ApiRequestOptions = {}): Promise<StatusResponse> {
  const path = '/session/reset';
  const outerRecord = requireRecord(await requestJson(path, { method: 'POST' }, options), path);
  const { event, data: record } = unwrapEventEnvelope(outerRecord);
  const snapshot = typeof record.snapshot === 'object' && record.snapshot !== null && !Array.isArray(record.snapshot)
    ? record.snapshot as Record<string, unknown>
    : null;
  const response: StatusResponse = {
    status: typeof record.status === 'string' ? record.status : 'Session reset',
    ...(typeof record.session_id === 'string'
      ? { session_id: record.session_id }
      : typeof snapshot?.session_id === 'string'
        ? { session_id: snapshot.session_id }
        : event && typeof event.session_id === 'string'
          ? { session_id: event.session_id }
          : {}),
  };
  invalidateSimSession('reset', response.session_id);
  return response;
}

export interface HealthResponse {
  status: string;
  sim_available: boolean;
  version?: string;
}

export async function fetchHealth(options: ApiRequestOptions = {}): Promise<HealthResponse> {
  const path = '/health';
  const record = requireRecord(await requestJson(path, {}, options), path);
  return {
    status: typeof record.status === 'string' ? record.status : 'unknown',
    sim_available: typeof record.sim_available === 'boolean' ? record.sim_available : false,
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
  };
}

export interface VoiceDescriptor {
  id: string;
  name: string;
  label: string;
}

export async function fetchVoices(options: ApiRequestOptions = {}): Promise<VoiceDescriptor[]> {
  const path = '/tts/voices';
  const payload = await requestJson(path, {}, options);
  if (!Array.isArray(payload)) {
    throw new ApiError({
      message: 'Voice response was not a list',
      code: 'INVALID_RESPONSE',
      url: resolveApiUrl(path),
      details: payload,
    });
  }
  return payload.flatMap((value): VoiceDescriptor[] => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    const voice = value as Record<string, unknown>;
    if (typeof voice.id !== 'string' || typeof voice.name !== 'string') return [];
    return [{
      id: voice.id,
      name: voice.name,
      label: typeof voice.label === 'string' ? voice.label : voice.name,
    }];
  });
}

export interface EmergencyResolutionResponse extends StatusResponse {
  squawk: string;
}

export async function resolveEmergency(options: ApiRequestOptions = {}): Promise<EmergencyResolutionResponse> {
  const path = '/emergency/resolve';
  const outerRecord = requireRecord(await requestJson(path, { method: 'POST' }, options), path);
  const { event, data: record } = unwrapEventEnvelope(outerRecord);
  return {
    status: typeof record.status === 'string' ? record.status : 'Emergency resolved',
    squawk: typeof record.squawk === 'string' ? record.squawk : '2000',
    ...(typeof record.session_id === 'string'
      ? { session_id: record.session_id }
      : event && typeof event.session_id === 'string' ? { session_id: event.session_id } : {}),
  };
}

export interface EmergencyStatusResponse {
  active: boolean;
  scenario: string;
  description: string;
  emergency_id?: string;
}

export async function fetchEmergencyStatus(options: ApiRequestOptions = {}): Promise<EmergencyStatusResponse> {
  const path = '/emergency/status';
  const record = requireRecord(await requestJson(path, {}, options), path);
  return {
    active: typeof record.active === 'boolean' ? record.active : false,
    scenario: typeof record.scenario === 'string' ? record.scenario : '',
    description: typeof record.description === 'string' ? record.description : '',
    ...(typeof record.emergency_id === 'string' ? { emergency_id: record.emergency_id } : {}),
  };
}

export interface AirportSearchResult {
  icao: string;
  name?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
  elev?: number;
  rwys?: string[];
  freq?: Record<string, number>;
}

function airportFromRecord(value: unknown): AirportSearchResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const airport = value as Record<string, unknown>;
  const icao = typeof airport.icao === 'string'
    ? airport.icao
    : typeof airport.ident === 'string' ? airport.ident : '';
  if (!icao) return null;
  const result: AirportSearchResult = { icao };
  if (typeof airport.name === 'string') result.name = airport.name;
  if (typeof airport.city === 'string') result.city = airport.city;
  if (typeof airport.country === 'string') result.country = airport.country;
  if (typeof airport.lat === 'number' && Number.isFinite(airport.lat)) result.lat = airport.lat;
  if (typeof airport.lon === 'number' && Number.isFinite(airport.lon)) result.lon = airport.lon;
  const elevation = typeof airport.elev === 'number' ? airport.elev : airport.elevation_ft;
  if (typeof elevation === 'number' && Number.isFinite(elevation)) result.elev = elevation;
  if (Array.isArray(airport.rwys)) result.rwys = airport.rwys.filter((item): item is string => typeof item === 'string');
  if (typeof airport.freq === 'object' && airport.freq !== null && !Array.isArray(airport.freq)) result.freq = airport.freq as Record<string, number>;
  return result;
}

export async function searchAirports(query: string, limit = 12, options: ApiRequestOptions = {}): Promise<AirportSearchResult[]> {
  const path = `/airports/search?q=${encodeURIComponent(query)}&limit=${Math.max(1, Math.min(50, Math.round(limit)))}`;
  const payload = await requestJson(path, {}, options);
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as Record<string, unknown>).airports)
      ? (payload as Record<string, unknown>).airports as unknown[]
      : [];
  return list.flatMap((value) => {
    const airport = airportFromRecord(value);
    return airport ? [airport] : [];
  });
}

export interface DemoRoutePayload {
  origin_icao: string;
  destination_icao: string;
  origin?: AirportSearchResult;
  destination?: AirportSearchResult;
  cruise_altitude_ft?: number;
  cruise_speed_kts?: number;
  time_scale?: number;
  auto_start?: boolean;
  callsign?: string;
}

export interface MutationEnvelope {
  event: Record<string, unknown> | null;
  data: Record<string, unknown>;
}

async function postMutation(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  const record = requireRecord(await requestJson(path, jsonPost(body), options), path);
  return unwrapEventEnvelope(record);
}

export async function startDemoRoute(payload: DemoRoutePayload, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  const manualAirport = (airport: AirportSearchResult | undefined) => {
    if (!airport || airport.lat == null || airport.lon == null) return undefined;
    const { icao: _icao, ...manual } = airport;
    void _icao;
    return manual;
  };
  return postMutation('/routes/demo', {
    ...payload,
    origin: manualAirport(payload.origin),
    destination: manualAirport(payload.destination),
  }, options);
}

export async function engageRoute(routeId: string, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postMutation(`/routes/${encodeURIComponent(routeId)}/engage`, {}, options);
}

export async function cancelRoute(routeId: string, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postMutation(`/routes/${encodeURIComponent(routeId)}/cancel`, {}, options);
}

export interface EmergencyCatalogItem {
  type: string;
  name: string;
  description: string;
  severity?: string;
}

export async function fetchEmergencyCatalog(options: ApiRequestOptions = {}): Promise<EmergencyCatalogItem[]> {
  const path = '/emergencies/catalog';
  const payload = await requestJson(path, {}, options);
  const catalog = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).emergencies
    : null;
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(catalog)
      ? catalog
      : typeof catalog === 'object' && catalog !== null
        ? Object.entries(catalog as Record<string, unknown>).map(([type, value]) => typeof value === 'object' && value !== null ? { type, ...(value as Record<string, unknown>) } : null)
      : typeof payload === 'object' && payload !== null
        ? Object.entries(payload as Record<string, unknown>).map(([type, value]) => typeof value === 'object' && value !== null ? { type, ...(value as Record<string, unknown>) } : null)
        : [];
  return raw.flatMap((value): EmergencyCatalogItem[] => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : typeof item.id === 'string' ? item.id : '';
    if (!type) return [];
    return [{
      type,
      name: typeof item.name === 'string' ? item.name : typeof item.title === 'string' ? item.title : type.replaceAll('_', ' '),
      description: typeof item.description === 'string' ? item.description : typeof item.summary === 'string' ? item.summary : 'State-driven emergency training workflow.',
      ...(typeof item.severity === 'string' ? { severity: item.severity } : {}),
    }];
  });
}

export interface ActivateEmergencyPayload {
  type: string;
  details?: string;
  auto_divert?: boolean;
}

export async function activateEmergency(payload: ActivateEmergencyPayload, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postMutation('/emergencies/activate', payload, options);
}

export async function completeEmergencyAction(emergencyId: string, actionId: string, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postMutation(`/emergencies/${encodeURIComponent(emergencyId)}/actions/${encodeURIComponent(actionId)}/complete`, { completed: true }, options);
}

export async function resolveEmergencyById(emergencyId: string, force = false, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postMutation(`/emergencies/${encodeURIComponent(emergencyId)}/resolve`, { force }, options);
}

export async function acceptClearance(clearanceId: string, readback: string, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postMutation(`/clearances/${encodeURIComponent(clearanceId)}/accept`, { readback }, options);
}
