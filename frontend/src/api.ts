import {
  invalidateSimSession,
  isSimSnapshotPayload,
} from './state/simState';
import { getActiveTrainingSessionId } from './state/trainingSession';
import { CommandContextUnavailableError, createCommandEnvelope, type CommandEnvelope } from './state/commandContext';
import type {
  AirportReference,
  ConnectionErrorInfo,
  ScenarioControlState,
  SimSnapshotPayload,
  SimStatePatch,
} from './types/sim';

const DEFAULT_TIMEOUT_MS = 12_000;
const MEDIA_TIMEOUT_MS = 45_000;
const AI_TIMEOUT_MS = 75_000;

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

export function resolveSimStateWebSocketUrl(sessionId = getActiveTrainingSessionId()): string {
  const url = new URL(resolveWebSocketUrl('/ws/state'));
  url.searchParams.set('session_id', sessionId);
  return url.toString();
}

export type ApiErrorCode =
  | 'ABORTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'API_ERROR'
  | 'COMMAND_CONFLICT'
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
  trainingSessionId?: string;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (typeof payload !== 'object' || payload === null) return fallback;
  const record = payload as Record<string, unknown>;
  for (const key of ['error', 'message', 'detail']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (key === 'detail' && typeof value === 'object' && value !== null) {
      const nested = errorMessage(value, '');
      if (nested) return nested;
    }
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
  const requestedTrainingSessionId = options.trainingSessionId || getActiveTrainingSessionId();
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
    const headers = new Headers(init.headers);
    headers.set('X-Session-ID', requestedTrainingSessionId);
    const response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
      credentials: init.credentials ?? 'same-origin',
    });
    if (!path.startsWith('/training-sessions') && requestedTrainingSessionId !== getActiveTrainingSessionId()) {
      throw new ApiError({ message: 'Request cancelled because the active training room changed.', code: 'ABORTED', url, retryable: false });
    }
    const servedTrainingSessionId = response.headers.get('X-Session-ID');
    if (!path.startsWith('/training-sessions') && servedTrainingSessionId && servedTrainingSessionId !== requestedTrainingSessionId) {
      throw new ApiError({ message: 'Backend responded from a different training room.', code: 'INVALID_RESPONSE', status: response.status, url, details: { requestedTrainingSessionId, servedTrainingSessionId }, retryable: false });
    }
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

export interface CommandReceipt {
  command_id: string;
  idempotency_key: string;
  operation: string;
  expected_sequence: number;
  expected_revision: number;
  sequence_before: number;
  sequence_after: number;
  revision_before: number;
  revision_after: number;
  issued_at: string;
  expires_at: string;
  executed_at: string;
  actor: string;
  legacy: boolean;
  deduplicated: boolean;
  status: 'succeeded';
}

export interface CommandAuditRecord {
  command: CommandEnvelope;
  operation: string;
  payload_checksum: string;
  status: 'pending' | 'succeeded' | 'rejected';
  legacy: boolean;
  deduplicated_count: number;
  received_at: string;
  completed_at: string | null;
  sequence_before: number;
  sequence_after: number | null;
  revision_before: number;
  revision_after: number | null;
  response_event_id: string | null;
  error_code: string | null;
  error_detail: string | null;
}

export interface CommandAuditPage {
  commands: CommandAuditRecord[];
  retained_count: number;
  max_retained: number;
}

interface EventEnvelopeRecord {
  event: Record<string, unknown> | null;
  data: Record<string, unknown>;
  command: CommandReceipt | null;
}

function invalidCommandResponse(path: string, message: string, details: unknown): never {
  throw new ApiError({ message, code: 'INVALID_RESPONSE', url: resolveApiUrl(path), details });
}

function commandString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string') invalidCommandResponse(path, `Command response is missing ${key}`, record);
  return value;
}

function commandNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidCommandResponse(path, `Command response has invalid ${key}`, record);
  return value;
}

function commandBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') invalidCommandResponse(path, `Command response has invalid ${key}`, record);
  return value;
}

function parseCommandEnvelope(payload: unknown, path: string): CommandEnvelope {
  const record = requireRecord(payload, path);
  return {
    command_id: commandString(record, 'command_id', path),
    idempotency_key: commandString(record, 'idempotency_key', path),
    expected_sequence: commandNumber(record, 'expected_sequence', path),
    expected_revision: commandNumber(record, 'expected_revision', path),
    issued_at: commandString(record, 'issued_at', path),
    expires_at: commandString(record, 'expires_at', path),
    actor: commandString(record, 'actor', path),
  };
}

function parseCommandReceipt(payload: unknown, path: string): CommandReceipt {
  const record = requireRecord(payload, path);
  if (record.status !== 'succeeded') invalidCommandResponse(path, 'Command receipt has an invalid status', record);
  return {
    ...parseCommandEnvelope(record, path),
    operation: commandString(record, 'operation', path),
    sequence_before: commandNumber(record, 'sequence_before', path),
    sequence_after: commandNumber(record, 'sequence_after', path),
    revision_before: commandNumber(record, 'revision_before', path),
    revision_after: commandNumber(record, 'revision_after', path),
    executed_at: commandString(record, 'executed_at', path),
    legacy: commandBoolean(record, 'legacy', path),
    deduplicated: commandBoolean(record, 'deduplicated', path),
    status: 'succeeded',
  };
}

function unwrapEventEnvelope(record: Record<string, unknown>, path = '/'): EventEnvelopeRecord {
  const event = typeof record.event === 'object' && record.event !== null && !Array.isArray(record.event)
    ? record.event as Record<string, unknown>
    : null;
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record;
  const command = record.command == null ? null : parseCommandReceipt(record.command, path);
  return { event, data, command };
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
  const record = requireRecord(await requestJson(path, jsonPost({ message }), {
    ...options,
    timeoutMs: options.timeoutMs ?? AI_TIMEOUT_MS,
  }), path);
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
  const mutation = await postCommandMutation(path, { callsign }, options);
  const { data } = mutation;
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
  }), {
    ...options,
    timeoutMs: options.timeoutMs ?? AI_TIMEOUT_MS,
  }), path);
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
  const { event, data: record } = await postCommandMutation(path, {}, options);
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
  const { event, data: record } = await postCommandMutation(path, {}, options);
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

export interface AlertAcknowledgementResponse {
  alert_id: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  changed: boolean;
  snapshot_sequence: number;
  event: Record<string, unknown> | null;
}

function parseAlertAcknowledgement(payload: unknown, path: string): AlertAcknowledgementResponse {
  const record = requireRecord(payload, path);
  const acknowledgement = requireRecord(record.acknowledgement, path);
  const alert = requireRecord(record.alert, path);
  const alertId = commandString(acknowledgement, 'alert_id', path);
  if (alert.alert_id !== alertId) invalidCommandResponse(path, 'Alert acknowledgement did not match the authoritative alert', record);
  const acknowledged = commandBoolean(acknowledgement, 'acknowledged', path);
  if (commandBoolean(alert, 'acknowledged', path) !== acknowledged) invalidCommandResponse(path, 'Alert acknowledgement state was internally inconsistent', record);
  const acknowledgedAt = acknowledgement.acknowledged_at;
  const acknowledgedBy = acknowledgement.acknowledged_by;
  if (acknowledgedAt !== null && typeof acknowledgedAt !== 'string') invalidCommandResponse(path, 'Alert acknowledgement has an invalid timestamp', record);
  if (acknowledgedBy !== null && typeof acknowledgedBy !== 'string') invalidCommandResponse(path, 'Alert acknowledgement has an invalid actor', record);
  const event = record.event == null
    ? null
    : typeof record.event === 'object' && !Array.isArray(record.event)
      ? record.event as Record<string, unknown>
      : invalidCommandResponse(path, 'Alert acknowledgement has an invalid event', record);
  return {
    alert_id: alertId,
    acknowledged,
    acknowledged_at: acknowledgedAt,
    acknowledged_by: acknowledgedBy,
    changed: commandBoolean(record, 'changed', path),
    snapshot_sequence: commandNumber(record, 'snapshot_sequence', path),
    event,
  };
}

async function setBackendAlertAcknowledgement(
  alertId: string,
  acknowledged: boolean,
  actor: string,
  options: ApiRequestOptions,
): Promise<AlertAcknowledgementResponse> {
  const action = acknowledged ? 'ack' : 'unack';
  const path = `/alerts/${encodeURIComponent(alertId)}/${action}`;
  return parseAlertAcknowledgement(
    await requestJson(path, jsonPost({ actor: actor.trim() || 'operator' }), options),
    path,
  );
}

export async function acknowledgeBackendAlert(alertId: string, actor = 'operator', options: ApiRequestOptions = {}): Promise<AlertAcknowledgementResponse> {
  return setBackendAlertAcknowledgement(alertId, true, actor, options);
}

export async function unacknowledgeBackendAlert(alertId: string, actor = 'operator', options: ApiRequestOptions = {}): Promise<AlertAcknowledgementResponse> {
  return setBackendAlertAcknowledgement(alertId, false, actor, options);
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
  origin?: DemoRouteManualAirport;
  destination?: DemoRouteManualAirport;
  cruise_altitude_ft?: number;
  cruise_speed_kts?: number;
  time_scale?: number;
  auto_start?: boolean;
  callsign?: string;
}

export interface DemoRouteManualAirport {
  name?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
  elev?: number;
  rwys?: string[];
  freq?: Record<string, number>;
}

export interface MutationEnvelope {
  event: Record<string, unknown> | null;
  data: Record<string, unknown>;
  command: CommandReceipt | null;
}

async function postMutation(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  const record = requireRecord(await requestJson(path, jsonPost(body), options), path);
  return unwrapEventEnvelope(record, path);
}

const COMMAND_CONFLICT_CODES = new Set([
  'stale_sequence',
  'stale_revision',
  'snapshot_revision_unavailable',
  'envelope_revision_mismatch',
  'future_snapshot',
  'command_expired',
  'expired',
  'command_not_yet_valid',
  'idempotency_conflict',
]);

function commandConflictDetail(details: unknown): Record<string, unknown> | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null;
  const outer = details as Record<string, unknown>;
  const nested = typeof outer.detail === 'object' && outer.detail !== null && !Array.isArray(outer.detail)
    ? outer.detail as Record<string, unknown>
    : outer;
  return typeof nested.code === 'string' && COMMAND_CONFLICT_CODES.has(nested.code) ? nested : null;
}

function commandConflictMessage(code: string): string {
  if (code === 'command_expired' || code === 'expired') {
    return 'This command expired before it could be committed. A fresh snapshot is loading; review the current state and send a new command.';
  }
  if (code === 'idempotency_conflict') {
    return 'The backend rejected a reused command identity. Nothing was retried; refresh and review the command audit before sending a new command.';
  }
  if (code === 'command_not_yet_valid') {
    return 'The command timestamp is ahead of the backend clock. Synchronize the system clock, refresh state, and review the command before trying again.';
  }
  return 'Flight state changed before this command could be committed. A fresh snapshot is loading; review the updated state and send the command again.';
}

function handleCommandFailure(error: unknown, path: string): never {
  if (!(error instanceof ApiError) || error.status !== 409) throw error;
  const detail = commandConflictDetail(error.details);
  if (!detail) throw error;
  invalidateSimSession('external');
  const code = String(detail.code);
  throw new ApiError({
    message: commandConflictMessage(code),
    code: 'COMMAND_CONFLICT',
    status: 409,
    url: resolveApiUrl(path),
    details: detail,
    retryable: false,
    cause: error,
  });
}

async function postCommandMutation(path: string, body: Record<string, unknown>, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  let command: CommandEnvelope;
  try {
    command = createCommandEnvelope(options.trainingSessionId || getActiveTrainingSessionId());
  } catch (error) {
    if (error instanceof CommandContextUnavailableError) invalidateSimSession('external');
    throw error;
  }
  try {
    return await postMutation(path, { ...body, command }, options);
  } catch (error) {
    return handleCommandFailure(error, path);
  }
}

export async function startDemoRoute(payload: DemoRoutePayload, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  const manualAirport = (airport: DemoRouteManualAirport | undefined) => {
    if (!airport || airport.lat == null || airport.lon == null) return undefined;
    return {
      ...(airport.name ? { name: airport.name } : {}),
      ...(airport.city ? { city: airport.city } : {}),
      ...(airport.country ? { country: airport.country } : {}),
      lat: airport.lat,
      lon: airport.lon,
      ...(airport.elev != null ? { elev: airport.elev } : {}),
      ...(airport.rwys ? { rwys: airport.rwys } : {}),
      ...(airport.freq ? { freq: airport.freq } : {}),
    };
  };
  return postCommandMutation('/routes/demo', {
    ...payload,
    origin: manualAirport(payload.origin),
    destination: manualAirport(payload.destination),
  }, options);
}

export async function engageRoute(routeId: string, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postCommandMutation(`/routes/${encodeURIComponent(routeId)}/engage`, {}, options);
}

export async function cancelRoute(routeId: string, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postCommandMutation(`/routes/${encodeURIComponent(routeId)}/cancel`, {}, options);
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
  return postCommandMutation('/emergencies/activate', { ...payload }, options);
}

export async function completeEmergencyAction(emergencyId: string, actionId: string, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postCommandMutation(`/emergencies/${encodeURIComponent(emergencyId)}/actions/${encodeURIComponent(actionId)}/complete`, { completed: true }, options);
}

export async function resolveEmergencyById(emergencyId: string, force = false, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postCommandMutation(`/emergencies/${encodeURIComponent(emergencyId)}/resolve`, { force }, options);
}

export async function acceptClearance(clearanceId: string, readback: string, options: ApiRequestOptions = {}): Promise<MutationEnvelope> {
  return postCommandMutation(`/clearances/${encodeURIComponent(clearanceId)}/accept`, { readback }, options);
}

export type { ScenarioControlState } from './types/sim';

export interface ScenarioControlUpdate {
  paused?: boolean;
  time_scale?: number;
}

export interface ScenarioControlMutation extends MutationEnvelope {
  control: ScenarioControlState;
}

export interface JournalEventMetadata {
  schema_version: string;
  event_id: string;
  event_type: string;
  session_id: string;
  sequence: number;
  state_revision: number;
  event_sequence: number;
  observed_at: string;
  server_time: string;
  source: string;
  data_age_ms: number;
}

export interface JournalEventRecord {
  metadata: JournalEventMetadata;
  snapshot_sequence: number;
  simulation_time_seconds: number;
  recorded_at: string;
  state_checksum: string;
  payload_size_bytes: number;
  payload_truncated: boolean;
  payload: Record<string, unknown>;
}

export interface JournalCheckpoint {
  checkpoint_id: string;
  session_id: string;
  event_sequence: number;
  snapshot_sequence: number;
  simulation_time_seconds: number;
  created_at: string;
  state_checksum: string;
  state: Record<string, unknown>;
}

export type BookmarkCategory = 'bookmark' | 'incident' | 'training' | 'review';

export interface TimelineBookmark {
  bookmark_id: string;
  session_id: string;
  event_id: string | null;
  event_sequence: number | null;
  snapshot_sequence: number;
  title: string;
  annotation: string;
  category: BookmarkCategory;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BookmarkCreatePayload {
  event_id?: string;
  event_sequence?: number;
  snapshot_sequence?: number;
  title: string;
  annotation?: string;
  category?: BookmarkCategory;
  tags?: string[];
  created_by?: string;
}

export interface BookmarkUpdatePayload {
  title?: string;
  annotation?: string;
  category?: BookmarkCategory;
  tags?: string[];
}

export interface JournalSessionSummary {
  session_id: string;
  created_at: string;
  closed_at: string | null;
  current: boolean;
  storage_backend: string;
  event_count: number;
  retained_event_count: number;
  checkpoint_count: number;
  bookmark_count: number;
  first_event_sequence: number | null;
  last_event_sequence: number | null;
  truncated_before_event_sequence: number;
  latest_snapshot_sequence: number;
  simulation_time_seconds: number;
}

export interface JournalEventPage {
  session: JournalSessionSummary;
  events: JournalEventRecord[];
  next_after_event_sequence: number | null;
  has_more: boolean;
}

export interface JournalReplayResponse {
  session: JournalSessionSummary;
  requested_from_event_sequence: number;
  requested_to_event_sequence: number | null;
  complete_from_requested_sequence: boolean;
  checkpoint: JournalCheckpoint;
  events: JournalEventRecord[];
  next_after_event_sequence: number | null;
  has_more: boolean;
}

export interface JournalExport {
  format_version: 'smart-atc.session.v1';
  exported_at: string;
  session: JournalSessionSummary;
  events: JournalEventRecord[];
  checkpoints: JournalCheckpoint[];
  bookmarks: TimelineBookmark[];
  manifest_checksum: string;
}

export interface JournalEventQuery {
  after_event_sequence?: number;
  limit?: number;
  event_type?: string;
}

export interface JournalReplayQuery {
  from_event_sequence?: number;
  to_event_sequence?: number;
  after_event_sequence?: number;
  limit?: number;
}

function invalidJournalResponse(path: string, message: string, details: unknown): never {
  throw new ApiError({ message, code: 'INVALID_RESPONSE', url: resolveApiUrl(path), details });
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string') invalidJournalResponse(path, `Backend response is missing ${key}`, record);
  return value as string;
}

function requiredNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidJournalResponse(path, `Backend response is missing ${key}`, record);
  return value as number;
}

function nullableString(record: Record<string, unknown>, key: string, path: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') invalidJournalResponse(path, `Backend returned an invalid ${key}`, record);
  return value as string;
}

function nullableNumberValue(record: Record<string, unknown>, key: string, path: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidJournalResponse(path, `Backend returned an invalid ${key}`, record);
  return value as number;
}

function requiredBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') invalidJournalResponse(path, `Backend response is missing ${key}`, record);
  return value as boolean;
}

function parseScenarioControl(payload: unknown, path: string): ScenarioControlState {
  const record = requireRecord(payload, path);
  const status = requiredString(record, 'status', path);
  if (status !== 'running' && status !== 'paused') invalidJournalResponse(path, 'Backend returned an invalid scenario status', record);
  return {
    session_id: requiredString(record, 'session_id', path),
    status: status as ScenarioControlState['status'],
    paused: requiredBoolean(record, 'paused', path),
    time_scale: requiredNumber(record, 'time_scale', path),
    simulation_time_seconds: requiredNumber(record, 'simulation_time_seconds', path),
    changed_at: requiredString(record, 'changed_at', path),
    snapshot_sequence: requiredNumber(record, 'snapshot_sequence', path),
  };
}

function parseJournalEventMetadata(payload: unknown, path: string): JournalEventMetadata {
  const record = requireRecord(payload, path);
  return {
    schema_version: requiredString(record, 'schema_version', path),
    event_id: requiredString(record, 'event_id', path),
    event_type: requiredString(record, 'event_type', path),
    session_id: requiredString(record, 'session_id', path),
    sequence: requiredNumber(record, 'sequence', path),
    state_revision: requiredNumber(record, 'state_revision', path),
    event_sequence: requiredNumber(record, 'event_sequence', path),
    observed_at: requiredString(record, 'observed_at', path),
    server_time: requiredString(record, 'server_time', path),
    source: requiredString(record, 'source', path),
    data_age_ms: requiredNumber(record, 'data_age_ms', path),
  };
}

function parseJournalEvent(payload: unknown, path: string): JournalEventRecord {
  const record = requireRecord(payload, path);
  const rawPayload = record.payload;
  if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) invalidJournalResponse(path, 'Backend returned an invalid journal event payload', record);
  return {
    metadata: parseJournalEventMetadata(record.metadata, path),
    snapshot_sequence: requiredNumber(record, 'snapshot_sequence', path),
    simulation_time_seconds: requiredNumber(record, 'simulation_time_seconds', path),
    recorded_at: requiredString(record, 'recorded_at', path),
    state_checksum: requiredString(record, 'state_checksum', path),
    payload_size_bytes: requiredNumber(record, 'payload_size_bytes', path),
    payload_truncated: requiredBoolean(record, 'payload_truncated', path),
    payload: rawPayload as Record<string, unknown>,
  };
}

function parseJournalCheckpoint(payload: unknown, path: string): JournalCheckpoint {
  const record = requireRecord(payload, path);
  const state = record.state;
  if (typeof state !== 'object' || state === null || Array.isArray(state)) invalidJournalResponse(path, 'Backend returned an invalid replay checkpoint state', record);
  return {
    checkpoint_id: requiredString(record, 'checkpoint_id', path),
    session_id: requiredString(record, 'session_id', path),
    event_sequence: requiredNumber(record, 'event_sequence', path),
    snapshot_sequence: requiredNumber(record, 'snapshot_sequence', path),
    simulation_time_seconds: requiredNumber(record, 'simulation_time_seconds', path),
    created_at: requiredString(record, 'created_at', path),
    state_checksum: requiredString(record, 'state_checksum', path),
    state: state as Record<string, unknown>,
  };
}

function parseSessionSummary(payload: unknown, path: string): JournalSessionSummary {
  const record = requireRecord(payload, path);
  return {
    session_id: requiredString(record, 'session_id', path),
    created_at: requiredString(record, 'created_at', path),
    closed_at: nullableString(record, 'closed_at', path),
    current: requiredBoolean(record, 'current', path),
    storage_backend: requiredString(record, 'storage_backend', path),
    event_count: requiredNumber(record, 'event_count', path),
    retained_event_count: requiredNumber(record, 'retained_event_count', path),
    checkpoint_count: requiredNumber(record, 'checkpoint_count', path),
    bookmark_count: requiredNumber(record, 'bookmark_count', path),
    first_event_sequence: nullableNumberValue(record, 'first_event_sequence', path),
    last_event_sequence: nullableNumberValue(record, 'last_event_sequence', path),
    truncated_before_event_sequence: requiredNumber(record, 'truncated_before_event_sequence', path),
    latest_snapshot_sequence: requiredNumber(record, 'latest_snapshot_sequence', path),
    simulation_time_seconds: requiredNumber(record, 'simulation_time_seconds', path),
  };
}

function parseBookmark(payload: unknown, path: string): TimelineBookmark {
  const record = requireRecord(payload, path);
  const category = requiredString(record, 'category', path);
  if (!['bookmark', 'incident', 'training', 'review'].includes(category)) invalidJournalResponse(path, 'Backend returned an invalid bookmark category', record);
  const tags = record.tags;
  if (!Array.isArray(tags) || !tags.every((item) => typeof item === 'string')) invalidJournalResponse(path, 'Backend returned invalid bookmark tags', record);
  return {
    bookmark_id: requiredString(record, 'bookmark_id', path),
    session_id: requiredString(record, 'session_id', path),
    event_id: nullableString(record, 'event_id', path),
    event_sequence: nullableNumberValue(record, 'event_sequence', path),
    snapshot_sequence: requiredNumber(record, 'snapshot_sequence', path),
    title: requiredString(record, 'title', path),
    annotation: requiredString(record, 'annotation', path),
    category: category as BookmarkCategory,
    tags: tags as string[],
    created_by: requiredString(record, 'created_by', path),
    created_at: requiredString(record, 'created_at', path),
    updated_at: requiredString(record, 'updated_at', path),
  };
}

function appendQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value));
  });
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function parseCommandAuditRecord(payload: unknown, path: string): CommandAuditRecord {
  const record = requireRecord(payload, path);
  const status = requiredString(record, 'status', path);
  if (status !== 'pending' && status !== 'succeeded' && status !== 'rejected') {
    invalidCommandResponse(path, 'Command audit record has an invalid status', record);
  }
  return {
    command: parseCommandEnvelope(record.command, path),
    operation: requiredString(record, 'operation', path),
    payload_checksum: requiredString(record, 'payload_checksum', path),
    status: status as CommandAuditRecord['status'],
    legacy: requiredBoolean(record, 'legacy', path),
    deduplicated_count: requiredNumber(record, 'deduplicated_count', path),
    received_at: requiredString(record, 'received_at', path),
    completed_at: nullableString(record, 'completed_at', path),
    sequence_before: requiredNumber(record, 'sequence_before', path),
    sequence_after: nullableNumberValue(record, 'sequence_after', path),
    revision_before: requiredNumber(record, 'revision_before', path),
    revision_after: nullableNumberValue(record, 'revision_after', path),
    response_event_id: nullableString(record, 'response_event_id', path),
    error_code: nullableString(record, 'error_code', path),
    error_detail: nullableString(record, 'error_detail', path),
  };
}

export interface CommandAuditQuery {
  limit?: number;
  status?: CommandAuditRecord['status'];
  operation?: string;
}

export async function listCommandAudit(query: CommandAuditQuery = {}, options: ApiRequestOptions = {}): Promise<CommandAuditPage> {
  const path = appendQuery('/commands', {
    limit: query.limit == null ? undefined : Math.max(1, Math.min(500, Math.round(query.limit))),
    status: query.status,
    operation: query.operation?.trim() || undefined,
  });
  const record = requireRecord(await requestJson(path, {}, options), path);
  if (!Array.isArray(record.commands)) invalidCommandResponse(path, 'Backend returned an invalid command audit page', record);
  return {
    commands: record.commands.map((item) => parseCommandAuditRecord(item, path)),
    retained_count: requiredNumber(record, 'retained_count', path),
    max_retained: requiredNumber(record, 'max_retained', path),
  };
}

export async function fetchCommandAudit(commandId: string, options: ApiRequestOptions = {}): Promise<CommandAuditRecord> {
  const path = `/commands/${encodeURIComponent(commandId)}`;
  return parseCommandAuditRecord(await requestJson(path, {}, options), path);
}

export async function fetchCommandAuditByIdempotencyKey(idempotencyKey: string, options: ApiRequestOptions = {}): Promise<CommandAuditRecord> {
  const path = `/commands/idempotency/${encodeURIComponent(idempotencyKey)}`;
  return parseCommandAuditRecord(await requestJson(path, {}, options), path);
}

async function postScenarioControl(path: string, body: unknown, options: ApiRequestOptions): Promise<ScenarioControlMutation> {
  const mutation = await postCommandMutation(
    path,
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {},
    options,
  );
  return { ...mutation, control: parseScenarioControl(mutation.data.control, path) };
}

export async function fetchScenarioControl(options: ApiRequestOptions = {}): Promise<ScenarioControlState> {
  const path = '/scenario/control';
  return parseScenarioControl(await requestJson(path, {}, options), path);
}

export async function updateScenarioControl(payload: ScenarioControlUpdate, options: ApiRequestOptions = {}): Promise<ScenarioControlMutation> {
  return postScenarioControl('/scenario/control', payload, options);
}

export async function pauseScenario(options: ApiRequestOptions = {}): Promise<ScenarioControlMutation> {
  return postScenarioControl('/scenario/pause', {}, options);
}

export async function resumeScenario(options: ApiRequestOptions = {}): Promise<ScenarioControlMutation> {
  return postScenarioControl('/scenario/resume', {}, options);
}

export async function setScenarioTimeScale(timeScale: number, options: ApiRequestOptions = {}): Promise<ScenarioControlMutation> {
  return postScenarioControl('/scenario/time-scale', { time_scale: timeScale }, options);
}

export async function listJournalSessions(limit = 20, options: ApiRequestOptions = {}): Promise<JournalSessionSummary[]> {
  const path = appendQuery('/sessions', { limit: Math.max(1, Math.min(100, Math.round(limit))) });
  const payload = await requestJson(path, {}, options);
  if (!Array.isArray(payload)) invalidJournalResponse(path, 'Backend returned an invalid session list', payload);
  return payload.map((item) => parseSessionSummary(item, path));
}

export async function fetchJournalSession(sessionId: string, options: ApiRequestOptions = {}): Promise<JournalSessionSummary> {
  const path = `/sessions/${encodeURIComponent(sessionId)}`;
  return parseSessionSummary(await requestJson(path, {}, options), path);
}

export async function fetchJournalEvents(sessionId: string, query: JournalEventQuery = {}, options: ApiRequestOptions = {}): Promise<JournalEventPage> {
  const basePath = `/sessions/${encodeURIComponent(sessionId)}/events`;
  const path = appendQuery(basePath, {
    after_event_sequence: query.after_event_sequence == null ? undefined : Math.max(0, Math.round(query.after_event_sequence)),
    limit: query.limit == null ? undefined : Math.max(1, Math.min(1_000, Math.round(query.limit))),
    event_type: query.event_type?.trim() || undefined,
  });
  const record = requireRecord(await requestJson(path, {}, options), path);
  if (!Array.isArray(record.events)) invalidJournalResponse(path, 'Backend returned an invalid journal event page', record);
  return {
    session: parseSessionSummary(record.session, path),
    events: record.events.map((item) => parseJournalEvent(item, path)),
    next_after_event_sequence: nullableNumberValue(record, 'next_after_event_sequence', path),
    has_more: requiredBoolean(record, 'has_more', path),
  };
}

export async function fetchJournalReplay(sessionId: string, query: JournalReplayQuery = {}, options: ApiRequestOptions = {}): Promise<JournalReplayResponse> {
  const basePath = `/sessions/${encodeURIComponent(sessionId)}/replay`;
  const path = appendQuery(basePath, {
    from_event_sequence: query.from_event_sequence == null ? undefined : Math.max(1, Math.round(query.from_event_sequence)),
    to_event_sequence: query.to_event_sequence == null ? undefined : Math.max(1, Math.round(query.to_event_sequence)),
    after_event_sequence: query.after_event_sequence == null ? undefined : Math.max(0, Math.round(query.after_event_sequence)),
    limit: query.limit == null ? undefined : Math.max(1, Math.min(2_000, Math.round(query.limit))),
  });
  const record = requireRecord(await requestJson(path, {}, options), path);
  if (!Array.isArray(record.events)) invalidJournalResponse(path, 'Backend returned an invalid replay response', record);
  return {
    session: parseSessionSummary(record.session, path),
    requested_from_event_sequence: requiredNumber(record, 'requested_from_event_sequence', path),
    requested_to_event_sequence: nullableNumberValue(record, 'requested_to_event_sequence', path),
    complete_from_requested_sequence: requiredBoolean(record, 'complete_from_requested_sequence', path),
    checkpoint: parseJournalCheckpoint(record.checkpoint, path),
    events: record.events.map((item) => parseJournalEvent(item, path)),
    next_after_event_sequence: nullableNumberValue(record, 'next_after_event_sequence', path),
    has_more: requiredBoolean(record, 'has_more', path),
  };
}

export async function fetchJournalExport(sessionId: string, options: ApiRequestOptions = {}): Promise<JournalExport> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/export`;
  const record = requireRecord(await requestJson(path, {}, options), path);
  if (record.format_version !== 'smart-atc.session.v1' || !Array.isArray(record.events) || !Array.isArray(record.checkpoints) || !Array.isArray(record.bookmarks)) {
    invalidJournalResponse(path, 'Backend returned an invalid session export', record);
  }
  return {
    format_version: 'smart-atc.session.v1',
    exported_at: requiredString(record, 'exported_at', path),
    session: parseSessionSummary(record.session, path),
    events: (record.events as unknown[]).map((item) => parseJournalEvent(item, path)),
    checkpoints: (record.checkpoints as unknown[]).map((item) => parseJournalCheckpoint(item, path)),
    bookmarks: (record.bookmarks as unknown[]).map((item) => parseBookmark(item, path)),
    manifest_checksum: requiredString(record, 'manifest_checksum', path),
  };
}

export async function listTimelineBookmarks(sessionId: string, options: ApiRequestOptions = {}): Promise<TimelineBookmark[]> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/bookmarks`;
  const payload = await requestJson(path, {}, options);
  if (!Array.isArray(payload)) invalidJournalResponse(path, 'Backend returned an invalid bookmark list', payload);
  return payload.map((item) => parseBookmark(item, path));
}

export async function createTimelineBookmark(sessionId: string, payload: BookmarkCreatePayload, options: ApiRequestOptions = {}): Promise<TimelineBookmark> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/bookmarks`;
  return parseBookmark(await requestJson(path, jsonPost(payload), options), path);
}

export async function updateTimelineBookmark(sessionId: string, bookmarkId: string, payload: BookmarkUpdatePayload, options: ApiRequestOptions = {}): Promise<TimelineBookmark> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/bookmarks/${encodeURIComponent(bookmarkId)}`;
  return parseBookmark(await requestJson(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, options), path);
}

export async function deleteTimelineBookmark(sessionId: string, bookmarkId: string, options: ApiRequestOptions = {}): Promise<void> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/bookmarks/${encodeURIComponent(bookmarkId)}`;
  await requestJson(path, { method: 'DELETE' }, options);
}

export interface TrainingSessionCreatePayload {
  name: string;
  idle_timeout_seconds?: number;
}

export interface TrainingSessionQuotaState {
  max_sessions: number;
  active_sessions: number;
  remaining_sessions: number;
  default_idle_timeout_seconds: number;
  max_idle_timeout_seconds: number;
  max_websocket_clients_per_session: number;
  max_commands_per_session: number;
}

export interface TrainingSessionMetadata {
  session_id: string;
  name: string;
  is_default: boolean;
  status: 'running' | 'stopped';
  created_at: string;
  last_accessed_at: string;
  idle_timeout_seconds: number;
  idle_seconds: number;
  expires_at: string | null;
  runtime_session_id: string;
  snapshot_sequence: number;
  active_requests: number;
  connected_websocket_clients: number;
  callsign: string;
  route_id: string | null;
  emergency_id: string | null;
  ai_history_messages: number;
  journal_session_count: number;
  command_count: number;
}

export interface TrainingSessionList {
  sessions: TrainingSessionMetadata[];
  quota: TrainingSessionQuotaState;
}

function parseTrainingSessionMetadata(payload: unknown, path: string): TrainingSessionMetadata {
  const record = requireRecord(payload, path);
  const status = requiredString(record, 'status', path);
  if (status !== 'running' && status !== 'stopped') invalidJournalResponse(path, 'Backend returned an invalid training-session status', record);
  return {
    session_id: requiredString(record, 'session_id', path),
    name: requiredString(record, 'name', path),
    is_default: requiredBoolean(record, 'is_default', path),
    status: status as TrainingSessionMetadata['status'],
    created_at: requiredString(record, 'created_at', path),
    last_accessed_at: requiredString(record, 'last_accessed_at', path),
    idle_timeout_seconds: requiredNumber(record, 'idle_timeout_seconds', path),
    idle_seconds: requiredNumber(record, 'idle_seconds', path),
    expires_at: nullableString(record, 'expires_at', path),
    runtime_session_id: requiredString(record, 'runtime_session_id', path),
    snapshot_sequence: requiredNumber(record, 'snapshot_sequence', path),
    active_requests: requiredNumber(record, 'active_requests', path),
    connected_websocket_clients: requiredNumber(record, 'connected_websocket_clients', path),
    callsign: requiredString(record, 'callsign', path),
    route_id: nullableString(record, 'route_id', path),
    emergency_id: nullableString(record, 'emergency_id', path),
    ai_history_messages: requiredNumber(record, 'ai_history_messages', path),
    journal_session_count: requiredNumber(record, 'journal_session_count', path),
    command_count: requiredNumber(record, 'command_count', path),
  };
}

function parseTrainingSessionQuota(payload: unknown, path: string): TrainingSessionQuotaState {
  const record = requireRecord(payload, path);
  return {
    max_sessions: requiredNumber(record, 'max_sessions', path),
    active_sessions: requiredNumber(record, 'active_sessions', path),
    remaining_sessions: requiredNumber(record, 'remaining_sessions', path),
    default_idle_timeout_seconds: requiredNumber(record, 'default_idle_timeout_seconds', path),
    max_idle_timeout_seconds: requiredNumber(record, 'max_idle_timeout_seconds', path),
    max_websocket_clients_per_session: requiredNumber(record, 'max_websocket_clients_per_session', path),
    max_commands_per_session: requiredNumber(record, 'max_commands_per_session', path),
  };
}

export async function createTrainingSession(payload: TrainingSessionCreatePayload, options: ApiRequestOptions = {}): Promise<TrainingSessionMetadata> {
  const path = '/training-sessions';
  return parseTrainingSessionMetadata(await requestJson(path, jsonPost(payload), options), path);
}

export async function listTrainingSessions(options: ApiRequestOptions = {}): Promise<TrainingSessionList> {
  const path = '/training-sessions';
  const record = requireRecord(await requestJson(path, {}, options), path);
  if (!Array.isArray(record.sessions)) invalidJournalResponse(path, 'Backend returned an invalid training-session list', record);
  return {
    sessions: record.sessions.map((session) => parseTrainingSessionMetadata(session, path)),
    quota: parseTrainingSessionQuota(record.quota, path),
  };
}

export async function fetchTrainingSession(sessionId: string, options: ApiRequestOptions = {}): Promise<TrainingSessionMetadata> {
  const path = `/training-sessions/${encodeURIComponent(sessionId)}`;
  return parseTrainingSessionMetadata(await requestJson(path, {}, options), path);
}

export async function touchTrainingSession(sessionId: string, options: ApiRequestOptions = {}): Promise<TrainingSessionMetadata> {
  const path = `/training-sessions/${encodeURIComponent(sessionId)}/touch`;
  return parseTrainingSessionMetadata(await requestJson(path, jsonPost({}), options), path);
}

export async function deleteTrainingSession(sessionId: string, options: ApiRequestOptions = {}): Promise<void> {
  const path = `/training-sessions/${encodeURIComponent(sessionId)}`;
  await requestJson(path, { method: 'DELETE' }, options);
}
