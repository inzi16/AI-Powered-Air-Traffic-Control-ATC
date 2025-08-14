import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudSun, Crosshair, Map, Radio, ShieldAlert } from 'lucide-react';
import {
  activateEmergency,
  completeEmergencyAction,
  fetchEmergencyCatalog,
  resetSession,
  resolveEmergencyById,
  searchAirports,
  setCallsign as apiSetCallsign,
  startDemoRoute,
} from './api';
import { useSimStream } from './hooks/useSimStream';
import { isEmergencySquawk } from './utils/format';
import { playEmergencyAlert } from './utils/sounds';
import ChatPanel, { type ChatMessage } from './components/ChatPanel';
import EventTimeline from './components/EventTimeline';
import FlightPanel from './components/FlightPanel';
import IntroScreen from './components/IntroScreen';
import type { AirportOption, DemoRouteRequest } from './components/RoutePlannerModal';
import type { EmergencyScenario } from './components/ScenarioModal';
import TopBar from './components/TopBar';
import WeatherBoard from './components/WeatherBoard';

const MapView = lazy(() => import('./components/MapView'));
const RadarScope = lazy(() => import('./components/RadarScope'));
const RoutePlannerModal = lazy(() => import('./components/RoutePlannerModal'));
const ScenarioModal = lazy(() => import('./components/ScenarioModal'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));

type MissionView = 'map' | 'radar' | 'weather';

const INITIAL_MESSAGES: ChatMessage[] = [{
  id: 'welcome',
  role: 'system',
  text: 'SkyCommand is ready. Plan a route, connect a simulator, or select an emergency training scenario.',
  timestamp: 'READY',
}];

export default function App() {
  const sim = useSimStream();
  const [compactMobile, setCompactMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [showIntro, setShowIntro] = useState(() => sessionStorage.getItem('skycommand-intro-seen') !== '1');
  const [missionView, setMissionView] = useState<MissionView>('map');
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [routeOpen, setRouteOpen] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [flightPanelOpen, setFlightPanelOpen] = useState(() => !window.matchMedia('(max-width: 720px)').matches);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [routeBusy, setRouteBusy] = useState(false);
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [emergencyError, setEmergencyError] = useState<string | null>(null);
  const [emergencyScenarios, setEmergencyScenarios] = useState<EmergencyScenario[]>([]);
  const [callsign, setCallsign] = useState('SKY101');
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [ttsVoice, setTtsVoice] = useState('en-GB-RyanNeural');
  const [pttKey, setPttKey] = useState('Space');
  const [micDeviceId, setMicDeviceId] = useState('');
  const [speakerDeviceId, setSpeakerDeviceId] = useState('');
  const previousEmergency = useRef(false);

  const emergencyActive = Boolean(sim.active_emergency) || sim.emergency_active || isEmergencySquawk(sim.squawk);

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
    setShowIntro(false);
  }, []);

  const updateCallsign = useCallback((value: string) => {
    const normalized = value.trim().toUpperCase();
    if (!normalized) return;
    setCallsign(normalized);
    void apiSetCallsign(normalized).catch(() => undefined);
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

  const missionTabs = useMemo(() => [
    { id: 'map' as const, label: 'Map', icon: <Map aria-hidden="true" /> },
    { id: 'radar' as const, label: 'Radar', icon: <Crosshair aria-hidden="true" /> },
    { id: 'weather' as const, label: 'Weather', icon: <CloudSun aria-hidden="true" /> },
  ], []);

  return (
    <div className={`app-shell ${emergencyActive ? 'is-emergency' : ''}`}>
      {showIntro && <IntroScreen onComplete={completeIntro} />}

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
        onFlightPanelToggle={() => { setCopilotOpen(false); setFlightPanelOpen((current) => !current); }}
        onCopilotToggle={() => { setFlightPanelOpen(false); setCopilotOpen((current) => !current); }}
        onNotificationsOpen={() => {
          const latest = sim.alerts[0] || sim.advisories[0];
          setToast({ message: latest ? `${latest.title}: ${latest.message}` : 'No active operational alerts.' });
        }}
      />

      <main className="operations-grid">
        <FlightPanel sim={sim} className={flightPanelOpen ? 'is-open' : ''} onPlanRoute={() => setRouteOpen(true)} />

        <section className="mission-workspace" aria-label="Flight operations workspace">
          <nav className="mission-tabs" aria-label="Mission views">
            <div className="mission-tabs__group" role="tablist">
              {missionTabs.map((tab) => <button className="mission-tab" type="button" role="tab" key={tab.id} aria-selected={missionView === tab.id} onClick={() => setMissionView(tab.id)}><span className="mission-tab__icon">{tab.icon}</span>{tab.label}</button>)}
            </div>
            <div className="mission-tools">
              <button className="icon-button" type="button" onClick={() => void sim.resync()} title="Resynchronize telemetry" aria-label="Resynchronize telemetry"><Radio aria-hidden="true" /></button>
              <button className="quiet-button" type="button" onClick={() => void handleReset()}>Reset session</button>
            </div>
          </nav>
          <div className="mission-canvas">
            {emergencyActive && <div className="emergency-banner"><ShieldAlert aria-hidden="true" /><strong>Emergency mode</strong><span>{sim.active_emergency?.title || `Squawk ${sim.squawk}`}</span><button className="quiet-button" type="button" onClick={() => setEmergencyOpen(true)}>Open checklist</button></div>}
            <div className={emergencyActive ? 'mission-view mission-view--alert' : 'mission-view'}>
              <Suspense fallback={<div className="canvas-loading"><span className="mode-dot" />Loading mission view</div>}>
                {missionView === 'map' && <MapView sim={sim} />}
                {missionView === 'radar' && <RadarScope sim={sim} />}
                {missionView === 'weather' && <WeatherBoard sim={sim} />}
              </Suspense>
            </div>
          </div>
        </section>

        <ChatPanel
          className={copilotOpen ? 'is-open' : ''}
          sim={sim}
          messages={messages}
          setMessages={setMessages}
          ttsEnabled={ttsEnabled}
          ttsVoice={ttsVoice}
          pttKey={pttKey}
          micDeviceId={micDeviceId}
          speakerDeviceId={speakerDeviceId}
          onCallsignUpdate={updateCallsign}
          onApplyAdvisory={(advisory) => setToast({ message: advisory.action || advisory.title || 'Advisory acknowledged.' })}
          onEmergencyAction={(actionId) => handleEmergencyAction(actionId)}
        />
        <button className={`mobile-scrim ${copilotOpen || (compactMobile && flightPanelOpen) ? 'is-visible' : ''}`} type="button" aria-label="Close side panel" onClick={() => { setCopilotOpen(false); setFlightPanelOpen(false); }} />
      </main>

      <EventTimeline sim={sim} messages={messages} dataAgeMs={sim.dataAgeMs} />

      <Suspense fallback={null}>
        <RoutePlannerModal open={routeOpen} onClose={() => setRouteOpen(false)} onSearch={handleAirportSearch} onStart={handleStartRoute} callsign={callsign} busy={routeBusy} error={routeError} />
        <ScenarioModal
          open={emergencyOpen}
          onClose={() => setEmergencyOpen(false)}
          scenarios={emergencyScenarios}
          activeEmergency={sim.active_emergency}
          onActivate={handleActivateEmergency}
          onCompleteAction={(emergencyId, actionId) => handleEmergencyAction(actionId, emergencyId)}
          onResolve={handleResolveEmergency}
          busy={emergencyBusy}
          error={emergencyError}
        />
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
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
