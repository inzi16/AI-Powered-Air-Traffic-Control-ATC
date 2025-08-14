import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Grid2X2,
  Moon,
  PanelLeft,
  PanelRight,
  Route,
  Settings,
  ShieldAlert,
  Sun,
} from 'lucide-react';
import { useTheme } from '../context/theme';

interface TopBarProps {
  backendOnline: boolean;
  simConnected: boolean;
  reconnecting?: boolean;
  dataAgeMs?: number | null;
  emergencyActive: boolean;
  modeLabel: string;
  onRoutePlanner: () => void;
  onEmergencyOpen: () => void;
  onSettingsOpen: () => void;
  onFlightPanelToggle: () => void;
  onCopilotToggle: () => void;
  onNotificationsOpen?: () => void;
}

export default function TopBar({
  backendOnline,
  simConnected,
  reconnecting = false,
  dataAgeMs,
  emergencyActive,
  modeLabel,
  onRoutePlanner,
  onEmergencyOpen,
  onSettingsOpen,
  onFlightPanelToggle,
  onCopilotToggle,
  onNotificationsOpen,
}: TopBarProps) {
  const { theme, toggleTheme } = useTheme();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const freshness = useMemo(() => {
    if (!backendOnline) return { className: 'is-offline', label: reconnecting ? 'Reconnecting' : 'Backend offline' };
    if (dataAgeMs != null && dataAgeMs > 5000) return { className: 'is-stale', label: `Telemetry stale ${Math.round(dataAgeMs / 1000)} s` };
    if (dataAgeMs != null) return { className: 'is-live', label: `Telemetry ${Math.max(1, Math.round(dataAgeMs))} ms` };
    return { className: 'is-live', label: 'Telemetry live' };
  }, [backendOnline, dataAgeMs, reconnecting]);

  return (
    <header className="app-topbar">
      <div className="brand-lockup">
        <button className="icon-button mobile-panel-button" type="button" aria-label="Toggle flight panel" onClick={onFlightPanelToggle}>
          <PanelLeft aria-hidden="true" />
        </button>
        <div className="brand-mark" aria-hidden="true"><Grid2X2 /></div>
        <span className="brand-name">SKYCOMMAND</span>
        <span className="mode-badge"><span className="mode-dot" />{emergencyActive ? 'Emergency mode' : modeLabel}</span>
      </div>

      <div className="utc-block" title="Coordinated Universal Time">
        <div className="utc-clock">{now.toISOString().slice(11, 19)}Z</div>
        <div className="utc-date">{now.toISOString().slice(0, 10)} UTC</div>
      </div>

      <div className="top-actions">
        <div className={`top-health ${freshness.className}`} role="status" aria-live="polite">
          <span className="health-dot" />
          <span>{freshness.label}</span>
          {simConnected && <span>· SIM</span>}
        </div>
        <button className="icon-button" type="button" title="Plan or demo a route" aria-label="Plan or demo a route" onClick={onRoutePlanner}>
          <Route aria-hidden="true" />
        </button>
        <button className={`icon-button ${emergencyActive ? 'is-active is-danger' : ''}`} type="button" title="Emergency scenarios" aria-label="Open emergency scenarios" onClick={onEmergencyOpen}>
          <ShieldAlert aria-hidden="true" />
        </button>
        <button className="icon-button" type="button" title="Notifications" aria-label="View alerts" onClick={onNotificationsOpen || onEmergencyOpen}>
          <Bell aria-hidden="true" />
        </button>
        <button className="icon-button" type="button" title="Settings" aria-label="Open settings" onClick={onSettingsOpen}>
          <Settings aria-hidden="true" />
        </button>
        <button className="icon-button" type="button" title={`Use ${theme === 'dark' ? 'warm light' : 'dark'} theme`} aria-label={`Use ${theme === 'dark' ? 'warm light' : 'dark'} theme`} onClick={toggleTheme}>
          {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
        </button>
        <button className="icon-button mobile-panel-button" type="button" aria-label="Toggle AI copilot" onClick={onCopilotToggle}>
          <PanelRight aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
