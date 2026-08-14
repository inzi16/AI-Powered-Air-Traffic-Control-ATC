import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, BellRing, Bot, CloudSun, Crosshair, Gauge, Map, Radio, Route, Settings, ShieldAlert, Users } from 'lucide-react';
import {
  ApiError,
  acknowledgeBackendAlert,
  activateEmergency,
  completeEmergencyAction,
  fetchEmergencyCatalog,
  fetchTrainingSession,
  pauseScenario,
  resetSession,
  resumeScenario,
  resolveEmergencyById,
  searchAirports,
  setScenarioTimeScale,
  startDemoRoute,
  type TrainingSessionMetadata,
  unacknowledgeBackendAlert,
} from './api';
import { useSimStream } from './hooks/useSimStream';
import { usePWA } from './hooks/usePWA';
import { isEmergencySquawk } from './utils/format';
import { playEmergencyAlert } from './utils/sounds';
import ChatPanel, { type ChatMessage } from './components/ChatPanel';
import AlertCenter from './components/AlertCenter';
import CommandPalette, { type PaletteCommand } from './components/CommandPalette';
import CriticalAlertAnnouncer from './components/CriticalAlertAnnouncer';
import EventTimeline from './components/EventTimeline';
import FlightPanel from './components/FlightPanel';
import IntroScreen from './components/IntroScreen';
import ReadinessBanner from './components/ReadinessBanner';
import ScenarioControlBar from './components/ScenarioControlBar';
import type { AirportOption, DemoRouteRequest } from './components/RoutePlannerModal';
import type { EmergencyScenario } from './components/ScenarioModal';
import TopBar from './components/TopBar';
import WeatherBoard from './components/WeatherBoard';
import { DEFAULT_SURVEILLANCE_FILTERS, type SurveillanceFilters } from './types/operations';
import { buildOperationalAlerts, type OperationalAlert } from './utils/operationalAlerts';
import {
  clearTrainingSessionFallbackNotice,
  DEFAULT_TRAINING_SESSION_ID,
  reportTrainingSessionUnavailable,
  setActiveTrainingSessionId,
  useActiveTrainingSessionId,
  useTrainingSessionFallbackNotice,
} from './state/trainingSession';

const MapView = lazy(() => import('./components/MapView'));
const RadarScope = lazy(() => import('./components/RadarScope'));
const RoutePlannerModal = lazy(() => import('./components/RoutePlannerModal'));
const ScenarioModal = lazy(() => import('./components/ScenarioModal'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const SessionArchive = lazy(() => import('./components/SessionArchive'));
const TrainingSessionLobby = lazy(() => import('./components/TrainingSessionLobby'));

type MissionView = 'map' | 'radar' | 'weather';

const EMPTY_ACKNOWLEDGED_IDS = new Set<string>();

interface AlertAcknowledgementState {
  sessionId: string;
  localIds: Set<string>;
  authoritativeOverrides: globalThis.Map<string, boolean>;
  pendingIds: Set<string>;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [role="textbox"], [contenteditable="true"]'));
}

const INITIAL_MESSAGES: ChatMessage[] = [{
  id: 'welcome',
  role: 'system',
  text: 'SMART ATC is ready. Plan a route, connect a telemetry source, or select an emergency training scenario.',
  timestamp: 'READY',
}];

export default function App() {
  const activeTrainingSessionId = useActiveTrainingSessionId();
  const trainingSessionFallbackNotice = useTrainingSessionFallbackNotice();
  const sim = useSimStream();
  const pwa = usePWA();
  const [compactMobile, setCompactMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [showIntro, setShowIntro] = useState(() => sessionStorage.getItem('skycommand-intro-seen') !== '1');
  const [introHandoff, setIntroHandoff] = useState(false);
  const [missionView, setMissionView] = useState<MissionView>('map');
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [routeOpen, setRouteOpen] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [alertCenterOpen, setAlertCenterOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [roomLobbyOpen, setRoomLobbyOpen] = useState(false);
  const [flightPanelOpen, setFlightPanelOpen] = useState(() => !window.matchMedia('(max-width: 720px)').matches);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [routeBusy, setRouteBusy] = useState(false);
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  const [scenarioControlBusy, setScenarioControlBusy] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [emergencyError, setEmergencyError] = useState<string | null>(null);
  const [scenarioControlError, setScenarioControlError] = useState<string | null>(null);
  const [emergencyScenarios, setEmergencyScenarios] = useState<EmergencyScenario[]>([]);
  const [callsign, setCallsign] = useState('SKY101');
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [ttsVoice, setTtsVoice] = useState('en-GB-RyanNeural');
  const [pttKey, setPttKey] = useState('Space');
  const [micDeviceId, setMicDeviceId] = useState('');
  const [speakerDeviceId, setSpeakerDeviceId] = useState('');
  const [selectedCallsign, setSelectedCallsign] = useState<string | null>(null);
  const [surveillanceFilters, setSurveillanceFilters] = useState<SurveillanceFilters>(DEFAULT_SURVEILLANCE_FILTERS);
  const [alertAcknowledgements, setAlertAcknowledgements] = useState<AlertAcknowledgementState>({
    sessionId: '',
    localIds: new Set(),
    authoritativeOverrides: new globalThis.Map(),
    pendingIds: new Set(),
  });
  const [activeRoomMetadata, setActiveRoomMetadata] = useState<TrainingSessionMetadata | null>(null);
  const previousEmergency = useRef(false);
  const previousTrainingRoom = useRef(activeTrainingSessionId);
  const focusAfterIntro = useRef(false);

  const emergencyActive = Boolean(sim.active_emergency) || sim.emergency_active || isEmergencySquawk(sim.squawk);
  const operationalAlerts = useMemo(() => buildOperationalAlerts(sim, { backendOnline: sim.backendOnline, dataAgeMs: sim.dataAgeMs }), [sim]);
  const acknowledgedAlertIds = useMemo(() => {
    const stateMatches = alertAcknowledgements.sessionId === sim.session_id;
    const ids = new Set(stateMatches ? alertAcknowledgements.localIds : EMPTY_ACKNOWLEDGED_IDS);
    operationalAlerts.forEach((alert) => {
      const acknowledged = alert.acknowledgementScope === 'authoritative'
        ? (stateMatches ? alertAcknowledgements.authoritativeOverrides.get(alert.id) : undefined) ?? alert.acknowledged
        : alert.acknowledged || (stateMatches && alertAcknowledgements.localIds.has(alert.id));
      if (acknowledged) ids.add(alert.id);
      else ids.delete(alert.id);
    });
    return ids;
  }, [alertAcknowledgements, operationalAlerts, sim.session_id]);
  const pendingAlertIds = alertAcknowledgements.sessionId === sim.session_id ? alertAcknowledgements.pendingIds : EMPTY_ACKNOWLEDGED_IDS;
  const unacknowledgedAlertCount = operationalAlerts.filter((alert) => alert.requiresAcknowledgement && !acknowledgedAlertIds.has(alert.id)).length;
  const readOnlyInterface = !pwa.online || !sim.backendOnline || sim.dataStale || !sim.connection.schema_compatible;
  const showReadinessBanner = readOnlyInterface || pwa.canInstall || pwa.updateAvailable;

  const updateSurveillanceFilters = useCallback((patch: Partial<SurveillanceFilters>) => {
    setSurveillanceFilters((current) => ({ ...current, ...patch }));
  }, []);

  const closeRoutePlanner = useCallback(() => setRouteOpen(false), []);
  const closeEmergencyPanel = useCallback(() => setEmergencyOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeCommandPalette = useCallback(() => setCommandPaletteOpen(false), []);
  const closeAlertCenter = useCallback(() => setAlertCenterOpen(false), []);
  const closeSessionArchive = useCallback(() => setArchiveOpen(false), []);
  const closeRoomLobby = useCallback(() => setRoomLobbyOpen(false), []);

  const switchTrainingRoom = useCallback((room: TrainingSessionMetadata) => {
    const changed = room.session_id !== activeTrainingSessionId;
    setActiveRoomMetadata(room);
    setActiveTrainingSessionId(room.session_id);
    setRoomLobbyOpen(false);
    setToast({
      message: changed
        ? `Entered ${room.name}. Live controls, telemetry, copilot context, and journal are now isolated to this room.`
        : `${room.name} is already the active training room.`,
    });
  }, [activeTrainingSessionId]);

  const setAlertAcknowledgement = useCallback(async (id: string, acknowledged: boolean) => {
    const alert = operationalAlerts.find((candidate) => candidate.id === id);
    if (!alert || !alert.requiresAcknowledgement) return;
    if (alert.acknowledgementScope === 'local' || !alert.authoritativeId) {
      setAlertAcknowledgements((current) => {
        const localIds = current.sessionId === sim.session_id ? new Set(current.localIds) : new Set<string>();
        if (acknowledged) localIds.add(id);
        else localIds.delete(id);
        return {
          sessionId: sim.session_id,
          localIds,
          authoritativeOverrides: current.sessionId === sim.session_id ? new globalThis.Map(current.authoritativeOverrides) : new globalThis.Map(),
          pendingIds: current.sessionId === sim.session_id ? new Set(current.pendingIds) : new Set(),
        };
      });
      return;
    }
    if (readOnlyInterface) {
      setToast({ message: 'Authoritative alert acknowledgement is unavailable until live state synchronization recovers.', error: true });
      return;
    }

    setAlertAcknowledgements((current) => {
      const authoritativeOverrides = current.sessionId === sim.session_id ? new globalThis.Map(current.authoritativeOverrides) : new globalThis.Map<string, boolean>();
      const pendingIds = current.sessionId === sim.session_id ? new Set(current.pendingIds) : new Set<string>();
      authoritativeOverrides.set(id, acknowledged);
      pendingIds.add(id);
      return {
        sessionId: sim.session_id,
        localIds: current.sessionId === sim.session_id ? new Set(current.localIds) : new Set(),
        authoritativeOverrides,
        pendingIds,
      };
    });

    try {
      if (acknowledged) await acknowledgeBackendAlert(alert.authoritativeId, 'operator');
      else await unacknowledgeBackendAlert(alert.authoritativeId, 'operator');
      await sim.resync();
    } catch (error) {
      setAlertAcknowledgements((current) => {
        if (current.sessionId !== sim.session_id) return current;
        const authoritativeOverrides = new globalThis.Map(current.authoritativeOverrides);
        authoritativeOverrides.delete(id);
        return { ...current, authoritativeOverrides };
      });
      await sim.resync().catch(() => undefined);
      setToast({ message: error instanceof Error ? error.message : 'Unable to update the authoritative alert acknowledgement.', error: true });
    } finally {
      setAlertAcknowledgements((current) => {
        if (current.sessionId !== sim.session_id) return current;
        const pendingIds = new Set(current.pendingIds);
        pendingIds.delete(id);
        return { ...current, pendingIds };
      });
    }
  }, [operationalAlerts, readOnlyInterface, sim]);

  const acknowledgeAllAlerts = useCallback((idsToAcknowledge: string[]) => {
    idsToAcknowledge.forEach((id) => { void setAlertAcknowledgement(id, true); });
  }, [setAlertAcknowledgement]);

  const inspectAlert = useCallback((alert: OperationalAlert) => {
    setAlertCenterOpen(false);
    if (alert.callsign) {
      setSelectedCallsign(alert.callsign);
      setSurveillanceFilters((current) => ({ ...current, showTraffic: true, altitudeBand: 'all' }));
      setMissionView('radar');
      return;
    }
    if (alert.category === 'emergency') {
      setEmergencyOpen(true);
      setMissionView('radar');
      return;
    }
    if (alert.category === 'weather') {
      setMissionView('weather');
      return;
    }
    setToast({ message: `${alert.title}: ${alert.message}` });
  }, []);

  useEffect(() => {
    setAlertAcknowledgements((current) => {
      if (current.sessionId !== sim.session_id || current.authoritativeOverrides.size === 0) return current;
      const authoritativeOverrides = new globalThis.Map(current.authoritativeOverrides);
      let changed = false;
      for (const [id, desired] of authoritativeOverrides) {
        const alert = operationalAlerts.find((candidate) => candidate.id === id);
        if (!alert || (alert.acknowledgementScope === 'authoritative' && alert.acknowledged === desired)) {
          authoritativeOverrides.delete(id);
          changed = true;
        }
      }
      return changed ? { ...current, authoritativeOverrides } : current;
    });
  }, [operationalAlerts, sim.session_id]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const handleChange = (event: MediaQueryListEvent) => {
      setCompactMobile(event.matches);
      if (event.matches) setFlightPanelOpen(false);
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setActiveRoomMetadata((current) => current?.session_id === activeTrainingSessionId ? current : null);
    fetchTrainingSession(activeTrainingSessionId, { signal: controller.signal })
      .then((room) => {
        if (!controller.signal.aborted) setActiveRoomMetadata(room);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof ApiError && error.code === 'ABORTED')) return;
        if (error instanceof ApiError && error.status === 404 && activeTrainingSessionId !== DEFAULT_TRAINING_SESSION_ID) {
          reportTrainingSessionUnavailable('It was not found or its idle timeout elapsed.');
        }
      });
    return () => controller.abort();
  }, [activeTrainingSessionId]);

  useEffect(() => {
    if (!trainingSessionFallbackNotice) return;
    setToast({ message: trainingSessionFallbackNotice, error: true });
    clearTrainingSessionFallbackNotice();
  }, [trainingSessionFallbackNotice]);

  useEffect(() => {
    if (previousTrainingRoom.current === activeTrainingSessionId) return;
    previousTrainingRoom.current = activeTrainingSessionId;
    setMessages([{
      id: `room-${activeTrainingSessionId}-${Date.now()}`,
      role: 'system',
      text: activeTrainingSessionId === DEFAULT_TRAINING_SESSION_ID
        ? 'Default training room active. Waiting for its authoritative state snapshot.'
        : `Isolated room ${activeTrainingSessionId.slice(0, 8)} active. Waiting for its authoritative state snapshot.`,
      timestamp: 'ROOM',
    }]);
    setSelectedCallsign(null);
    setSurveillanceFilters(DEFAULT_SURVEILLANCE_FILTERS);
    setAlertAcknowledgements({ sessionId: '', localIds: new Set(), authoritativeOverrides: new globalThis.Map(), pendingIds: new Set() });
    setMissionView('map');
    setCallsign('SKY101');
    setRouteError(null);
    setEmergencyError(null);
    setScenarioControlError(null);
    setRouteOpen(false);
    setEmergencyOpen(false);
    setSettingsOpen(false);
    setCommandPaletteOpen(false);
    setAlertCenterOpen(false);
    setArchiveOpen(false);
    previousEmergency.current = false;
  }, [activeTrainingSessionId]);

  useEffect(() => {
    if (sim.callsign) setCallsign(sim.callsign);
  }, [sim.callsign]);

  useEffect(() => {
    if (emergencyActive && !previousEmergency.current && !showIntro) {
      playEmergencyAlert();
      setEmergencyOpen(true);
      setMissionView('radar');
    }
    previousEmergency.current = emergencyActive;
  }, [emergencyActive, showIntro]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    fetchEmergencyCatalog()
      .then((catalog) => setEmergencyScenarios(catalog))
      .catch(() => setEmergencyScenarios([]));
  }, []);

  const completeIntro = useCallback(() => {
    sessionStorage.setItem('skycommand-intro-seen', '1');
    focusAfterIntro.current = true;
    setIntroHandoff(false);
    setShowIntro(false);
  }, []);

  useEffect(() => {
    if (showIntro || !focusAfterIntro.current) return undefined;
    focusAfterIntro.current = false;
    const frame = window.requestAnimationFrame(() => document.getElementById('main-operations')?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [showIntro]);

  const beginIntroHandoff = useCallback(() => {
    setIntroHandoff(true);
  }, []);

  const updateCallsign = useCallback((value: string) => {
    const normalized = value.trim().toUpperCase();
    if (!normalized) return;
    setCallsign(normalized);
  }, []);

  const handleReset = useCallback(async () => {
    try {
      await resetSession();
      setMessages(INITIAL_MESSAGES);
      setMissionView('map');
      await sim.resync();
      setToast({ message: 'Training session reset and state stream resynchronized.' });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Unable to reset the session.', error: true });
    }
  }, [sim]);

  const handleAirportSearch = useCallback(async (query: string): Promise<AirportOption[]> => {
    const result = await searchAirports(query);
    return result;
  }, []);

  const handleStartRoute = useCallback(async (request: DemoRouteRequest) => {
    setRouteBusy(true);
    setRouteError(null);
    try {
      await startDemoRoute(request);
      await sim.resync();
      setRouteOpen(false);
      setMissionView('map');
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'system',
        text: `Synchronized route started: ${request.origin_icao} to ${request.destination_icao} at ${request.time_scale}x simulated time.`,
        timestamp: new Date().toISOString().slice(11, 19),
      }]);
      setToast({ message: `${request.origin_icao} to ${request.destination_icao} demo is active.` });
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : 'Unable to start the route.');
    } finally {
      setRouteBusy(false);
    }
  }, [sim]);

  const handleActivateEmergency = useCallback(async (type: string, details?: string, autoDivert?: boolean) => {
    setEmergencyBusy(true);
    setEmergencyError(null);
    try {
      await activateEmergency({ type, details, auto_divert: autoDivert });
      await sim.resync();
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'system',
        text: `Emergency injected: ${type.replaceAll('_', ' ')}. Deterministic stabilization workflow is now active.`,
        timestamp: new Date().toISOString().slice(11, 19),
      }]);
      setMissionView('radar');
    } catch (error) {
      setEmergencyError(error instanceof Error ? error.message : 'Unable to activate the emergency.');
    } finally {
      setEmergencyBusy(false);
    }
  }, [sim]);

  const handleEmergencyAction = useCallback(async (actionId: string, emergencyId = sim.active_emergency?.id) => {
    if (!emergencyId) return;
    setEmergencyBusy(true);
    setEmergencyError(null);
    try {
      await completeEmergencyAction(emergencyId, actionId);
      await sim.resync();
    } catch (error) {
      setEmergencyError(error instanceof Error ? error.message : 'The emergency action could not be completed.');
    } finally {
      setEmergencyBusy(false);
    }
  }, [sim]);

  const handleResolveEmergency = useCallback(async (emergencyId: string) => {
    setEmergencyBusy(true);
    setEmergencyError(null);
    try {
      await resolveEmergencyById(emergencyId);
      await sim.resync();
      setEmergencyOpen(false);
      setToast({ message: 'Emergency resolved after all required criteria were met.' });
    } catch (error) {
      setEmergencyError(error instanceof Error ? error.message : 'Resolution criteria are not yet satisfied.');
    } finally {
      setEmergencyBusy(false);
    }
  }, [sim]);

  const handleScenarioToggle = useCallback(async () => {
    setScenarioControlBusy(true);
    setScenarioControlError(null);
    try {
      const result = sim.scenario_control.paused ? await resumeScenario() : await pauseScenario();
      await sim.resync();
      setToast({ message: result.control.paused ? 'Live simulation paused. State heartbeat remains synchronized.' : 'Live simulation resumed.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update live scenario control.';
      setScenarioControlError(message);
      setToast({ message, error: true });
    } finally {
      setScenarioControlBusy(false);
    }
  }, [sim]);

  const handleScenarioTimeScale = useCallback(async (timeScale: number) => {
    setScenarioControlBusy(true);
    setScenarioControlError(null);
    try {
      const result = await setScenarioTimeScale(timeScale);
      await sim.resync();
      setToast({ message: `Live simulation time scale set to ${result.control.time_scale}×.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update simulation time scale.';
      setScenarioControlError(message);
      setToast({ message, error: true });
    } finally {
      setScenarioControlBusy(false);
    }
  }, [sim]);

  const missionTabs = useMemo(() => [
    { id: 'map' as const, label: 'Map', icon: <Map aria-hidden="true" /> },
    { id: 'radar' as const, label: 'Radar', icon: <Crosshair aria-hidden="true" /> },
    { id: 'weather' as const, label: 'Weather', icon: <CloudSun aria-hidden="true" /> },
  ], []);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const primaryConflict = sim.conflicts[0];
    return [
      { id: 'view-map', label: 'Open geographic map', description: 'Show the route, ownship trail, airports, and traffic.', group: 'Views', shortcut: 'M', icon: <Map aria-hidden="true" />, run: () => setMissionView('map'), keywords: ['navigation', 'route'] },
      { id: 'view-radar', label: 'Open surveillance radar', description: 'Show sector traffic, vectors, and closest-point geometry.', group: 'Views', shortcut: 'R', icon: <Crosshair aria-hidden="true" />, run: () => setMissionView('radar'), keywords: ['traffic', 'conflict'] },
      { id: 'view-weather', label: 'Open weather board', description: 'Review wind, visibility, ceiling, and operating guidance.', group: 'Views', shortcut: 'W', icon: <CloudSun aria-hidden="true" />, run: () => setMissionView('weather'), keywords: ['metar', 'conditions'] },
      { id: 'alerts', label: 'Open alert center', description: `${unacknowledgedAlertCount} operational alert${unacknowledgedAlertCount === 1 ? '' : 's'} require acknowledgement.`, group: 'Safety', shortcut: 'A', icon: <BellRing aria-hidden="true" />, run: () => setAlertCenterOpen(true), keywords: ['warning', 'notifications'] },
      { id: 'emergency', label: 'Emergency scenarios', description: 'Inject or manage deterministic emergency training.', group: 'Safety', shortcut: 'E', icon: <ShieldAlert aria-hidden="true" />, run: () => setEmergencyOpen(true), keywords: ['checklist', 'mayday', 'scenario'] },
      { id: 'primary-conflict', label: primaryConflict ? `Inspect conflict ${primaryConflict.callsign}` : 'Inspect primary conflict', description: primaryConflict ? `${primaryConflict.range_nm.toFixed(1)} NM range — open linked radar track.` : 'No traffic conflict is currently predicted.', group: 'Safety', icon: <Crosshair aria-hidden="true" />, disabled: !primaryConflict, run: () => { if (primaryConflict) { setSelectedCallsign(primaryConflict.callsign); setSurveillanceFilters((current) => ({ ...current, showTraffic: true, altitudeBand: 'all' })); setMissionView('radar'); } }, keywords: ['traffic', 'target', 'cpa'] },
      { id: 'route', label: 'Plan or demo a route', description: 'Start an airport-to-airport synchronized training flight.', group: 'Mission', shortcut: 'P', icon: <Route aria-hidden="true" />, run: () => setRouteOpen(true), keywords: ['airport', 'flight plan'] },
      { id: 'scenario-control', label: sim.scenario_control.paused ? 'Resume live simulation' : 'Pause live simulation', description: readOnlyInterface ? 'Live scenario controls are disabled until authoritative telemetry recovers.' : sim.scenario_control.paused ? `Resume the authoritative clock at ${sim.scenario_control.time_scale}×.` : 'Freeze simulation movement while preserving state heartbeats.', group: 'Mission', icon: <Gauge aria-hidden="true" />, disabled: readOnlyInterface, run: () => { void handleScenarioToggle(); }, keywords: ['pause', 'resume', 'clock', 'time scale'] },
      { id: 'session-archive', label: 'Open session archive', description: 'Browse semantic events, read-only replay checkpoints, bookmarks, and exports.', group: 'Debrief', shortcut: 'J', icon: <Archive aria-hidden="true" />, run: () => setArchiveOpen(true), keywords: ['journal', 'replay', 'history', 'export', 'bookmark'] },
      { id: 'training-rooms', label: 'Manage training rooms', description: `${activeRoomMetadata?.name || (activeTrainingSessionId === DEFAULT_TRAINING_SESSION_ID ? 'Default room' : activeTrainingSessionId.slice(0, 8))} is active. Create, join, switch, share, or retire isolated runtimes.`, group: 'Workspace', shortcut: 'L', icon: <Users aria-hidden="true" />, run: () => setRoomLobbyOpen(true), keywords: ['lobby', 'session', 'multiplayer', 'instructor', 'runtime'] },
      { id: 'flight-panel', label: 'Toggle flight data panel', description: 'Show aircraft phase, position, speed, and altitude.', group: 'Workspace', shortcut: 'F', icon: <Gauge aria-hidden="true" />, run: () => { setCopilotOpen(false); setFlightPanelOpen((current) => !current); }, keywords: ['telemetry', 'metrics'] },
      { id: 'copilot', label: 'Toggle ATC copilot', description: 'Open guidance, voice, and ATC conversation tools.', group: 'Workspace', shortcut: 'C', icon: <Bot aria-hidden="true" />, run: () => { setFlightPanelOpen(false); setCopilotOpen((current) => !current); }, keywords: ['chat', 'voice', 'assistant'] },
      { id: 'resync', label: 'Resynchronize telemetry', description: 'Request a fresh authoritative state snapshot.', group: 'System', icon: <Radio aria-hidden="true" />, run: () => { void sim.resync(); }, keywords: ['refresh', 'connection', 'state'] },
      { id: 'clear-filters', label: 'Reset surveillance filters', description: 'Restore all traffic, altitude bands, route, and trail layers.', group: 'System', icon: <Crosshair aria-hidden="true" />, run: () => setSurveillanceFilters(DEFAULT_SURVEILLANCE_FILTERS), keywords: ['radar', 'map', 'layers'] },
      { id: 'settings', label: 'Open settings', description: 'Configure voice, audio devices, motion, and interaction.', group: 'System', shortcut: 'S', icon: <Settings aria-hidden="true" />, run: () => setSettingsOpen(true), keywords: ['microphone', 'speaker', 'accessibility'] },
    ];
  }, [activeRoomMetadata?.name, activeTrainingSessionId, handleScenarioToggle, readOnlyInterface, sim, unacknowledgedAlertCount]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (showIntro || event.repeat) return;
      const key = event.key.toLowerCase();
      const commandShortcut = (event.ctrlKey || event.metaKey) && key === 'k';
      if (commandShortcut) {
        event.preventDefault();
        if (!routeOpen && !emergencyOpen && !settingsOpen && !alertCenterOpen && !archiveOpen && !roomLobbyOpen) setCommandPaletteOpen(true);
        return;
      }
      if (commandPaletteOpen || alertCenterOpen || archiveOpen || roomLobbyOpen || routeOpen || emergencyOpen || settingsOpen || isEditableKeyboardTarget(event.target)) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      const actions: Record<string, () => void> = {
        '/': () => setCommandPaletteOpen(true),
        '?': () => setCommandPaletteOpen(true),
        m: () => setMissionView('map'),
        r: () => setMissionView('radar'),
        w: () => setMissionView('weather'),
        a: () => setAlertCenterOpen(true),
        p: () => setRouteOpen(true),
        e: () => setEmergencyOpen(true),
        j: () => setArchiveOpen(true),
        l: () => setRoomLobbyOpen(true),
        s: () => setSettingsOpen(true),
        f: () => { setCopilotOpen(false); setFlightPanelOpen((current) => !current); },
        c: () => { setFlightPanelOpen(false); setCopilotOpen((current) => !current); },
      };
      const action = actions[key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [alertCenterOpen, archiveOpen, commandPaletteOpen, emergencyOpen, roomLobbyOpen, routeOpen, settingsOpen, showIntro]);

  return (
    <div className={`app-shell ${emergencyActive ? 'is-emergency' : ''} ${showReadinessBanner ? 'has-readiness-banner' : ''} ${showIntro ? 'is-intro-active' : ''} ${introHandoff ? 'is-intro-handoff' : ''}`} inert={showIntro || undefined}>
      {showIntro && <IntroScreen onHandoffStart={beginIntroHandoff} onComplete={completeIntro} />}
      {!showIntro && <a className="skip-link" href="#main-operations">Skip to flight operations</a>}
      <CriticalAlertAnnouncer alerts={operationalAlerts} scopeId={activeTrainingSessionId} />

      <TopBar
        backendOnline={sim.backendOnline}
        simConnected={sim.source === 'simconnect' && sim.connected}
        reconnecting={sim.reconnecting}
        dataAgeMs={sim.dataAgeMs}
        emergencyActive={emergencyActive}
        modeLabel={sim.route ? 'Flight active' : 'Training mode'}
        onRoutePlanner={() => setRouteOpen(true)}
        onEmergencyOpen={() => setEmergencyOpen(true)}
        onSettingsOpen={() => setSettingsOpen(true)}
        onCommandPaletteOpen={() => setCommandPaletteOpen(true)}
        onFlightPanelToggle={() => { setCopilotOpen(false); setFlightPanelOpen((current) => !current); }}
        onCopilotToggle={() => { setFlightPanelOpen(false); setCopilotOpen((current) => !current); }}
        onNotificationsOpen={() => setAlertCenterOpen(true)}
        alertCount={unacknowledgedAlertCount}
        activeRoomId={activeTrainingSessionId}
        activeRoomName={activeRoomMetadata?.name || (activeTrainingSessionId === DEFAULT_TRAINING_SESSION_ID ? 'Default room' : `Room ${activeTrainingSessionId.slice(0, 8)}`)}
        onRoomManagerOpen={() => setRoomLobbyOpen(true)}
      />

      {showReadinessBanner && <ReadinessBanner online={pwa.online} backendOnline={sim.backendOnline} reconnecting={sim.reconnecting} dataStale={sim.dataStale} schemaCompatible={sim.connection.schema_compatible} schemaError={sim.connection.schema_error} canInstall={pwa.canInstall} updateAvailable={pwa.updateAvailable} applying={pwa.applying} onInstall={pwa.install} onUpdate={pwa.applyUpdate} />}

      <main className="operations-grid" id="main-operations" tabIndex={-1}>
        <FlightPanel sim={sim} className={flightPanelOpen ? 'is-open' : ''} onPlanRoute={() => setRouteOpen(true)} />

        <section className="mission-workspace" aria-label="Flight operations workspace">
          <nav className="mission-tabs" aria-label="Mission views">
            <div className="mission-tabs__group" role="tablist">
              {missionTabs.map((tab) => <button className="mission-tab" type="button" role="tab" key={tab.id} aria-selected={missionView === tab.id} onClick={() => setMissionView(tab.id)}><span className="mission-tab__icon">{tab.icon}</span>{tab.label}</button>)}
            </div>
            <div className="mission-tools">
              <ScenarioControlBar control={sim.scenario_control} disabled={readOnlyInterface} busy={scenarioControlBusy} error={scenarioControlError} onToggle={() => void handleScenarioToggle()} onTimeScaleChange={(scale) => void handleScenarioTimeScale(scale)} />
              <button className="icon-button" type="button" onClick={() => void sim.resync()} title="Resynchronize telemetry" aria-label="Resynchronize telemetry"><Radio aria-hidden="true" /></button>
              <button className="quiet-button" type="button" disabled={readOnlyInterface} onClick={() => void handleReset()}>Reset session</button>
            </div>
          </nav>
          <div className="mission-canvas">
            {emergencyActive && <div className="emergency-banner"><ShieldAlert aria-hidden="true" /><strong>Emergency mode</strong><span>{sim.active_emergency?.title || `Squawk ${sim.squawk}`}</span><button className="quiet-button" type="button" onClick={() => setEmergencyOpen(true)}>Open checklist</button></div>}
            <div className={emergencyActive ? 'mission-view mission-view--alert' : 'mission-view'}>
              <Suspense fallback={<div className="canvas-loading"><span className="mode-dot" />Loading mission view</div>}>
                {missionView === 'map' && <MapView sim={sim} filters={surveillanceFilters} onFiltersChange={updateSurveillanceFilters} selectedCallsign={selectedCallsign} onSelectCallsign={setSelectedCallsign} />}
                {missionView === 'radar' && <RadarScope sim={sim} filters={surveillanceFilters} onFiltersChange={updateSurveillanceFilters} selectedCallsign={selectedCallsign} onSelectCallsign={setSelectedCallsign} />}
                {missionView === 'weather' && <WeatherBoard sim={sim} />}
              </Suspense>
            </div>
          </div>
        </section>

        <ChatPanel
          key={activeTrainingSessionId}
          className={copilotOpen ? 'is-open' : ''}
          sim={sim}
          messages={messages}
          setMessages={setMessages}
          ttsEnabled={ttsEnabled}
          ttsVoice={ttsVoice}
          pttKey={pttKey}
          readOnly={readOnlyInterface}
          micDeviceId={micDeviceId}
          speakerDeviceId={speakerDeviceId}
          onCallsignUpdate={updateCallsign}
          onApplyAdvisory={(advisory) => setToast({ message: advisory.action || advisory.title || 'Advisory acknowledged.' })}
          onEmergencyAction={(actionId) => handleEmergencyAction(actionId)}
        />
        <button className={`mobile-scrim ${copilotOpen || (compactMobile && flightPanelOpen) ? 'is-visible' : ''}`} type="button" aria-label="Close side panel" onClick={() => { setCopilotOpen(false); setFlightPanelOpen(false); }} />
      </main>

      <EventTimeline key={activeTrainingSessionId} sim={sim} messages={messages} dataAgeMs={sim.dataAgeMs} onSelectTarget={(target) => { setSelectedCallsign(target); setSurveillanceFilters((current) => ({ ...current, showTraffic: true, altitudeBand: 'all' })); setMissionView('radar'); }} onOpenArchive={() => setArchiveOpen(true)} />

      <CommandPalette open={commandPaletteOpen} commands={paletteCommands} onClose={closeCommandPalette} />
      <AlertCenter
        open={alertCenterOpen}
        alerts={operationalAlerts}
        acknowledgedIds={acknowledgedAlertIds}
        pendingIds={pendingAlertIds}
        authoritativeReadOnly={readOnlyInterface}
        onAcknowledge={(id) => { void setAlertAcknowledgement(id, true); }}
        onUnacknowledge={(id) => { void setAlertAcknowledgement(id, false); }}
        onAcknowledgeAll={acknowledgeAllAlerts}
        onInspect={inspectAlert}
        onClose={closeAlertCenter}
      />

      <Suspense fallback={null}>
        <TrainingSessionLobby open={roomLobbyOpen} activeSessionId={activeTrainingSessionId} onSwitch={switchTrainingRoom} onClose={closeRoomLobby} />
        <SessionArchive key={activeTrainingSessionId} open={archiveOpen} currentSessionId={sim.session_id} onClose={closeSessionArchive} />
        <RoutePlannerModal open={routeOpen} onClose={closeRoutePlanner} onSearch={handleAirportSearch} onStart={handleStartRoute} callsign={callsign} busy={routeBusy} error={routeError} readOnly={readOnlyInterface} />
        <ScenarioModal
          open={emergencyOpen}
          onClose={closeEmergencyPanel}
          scenarios={emergencyScenarios}
          activeEmergency={sim.active_emergency}
          onActivate={handleActivateEmergency}
          onCompleteAction={(emergencyId, actionId) => handleEmergencyAction(actionId, emergencyId)}
          onResolve={handleResolveEmergency}
          busy={emergencyBusy}
          error={emergencyError}
          readOnly={readOnlyInterface}
        />
        <SettingsModal
          open={settingsOpen}
          onClose={closeSettings}
          ttsEnabled={ttsEnabled}
          setTtsEnabled={setTtsEnabled}
          ttsVoice={ttsVoice}
          setTtsVoice={setTtsVoice}
          pttKey={pttKey}
          setPttKey={setPttKey}
          micDeviceId={micDeviceId}
          setMicDeviceId={setMicDeviceId}
          speakerDeviceId={speakerDeviceId}
          setSpeakerDeviceId={setSpeakerDeviceId}
        />
      </Suspense>

      {toast && <div className="toast-region" role="status" aria-live="polite"><div className={`toast ${toast.error ? 'is-error' : ''}`}>{toast.message}</div></div>}
    </div>
  );
}
