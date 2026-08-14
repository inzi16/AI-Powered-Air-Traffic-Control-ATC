import { CloudOff, Download, LoaderCircle, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';

interface Props {
  online: boolean;
  backendOnline: boolean;
  reconnecting: boolean;
  dataStale: boolean;
  schemaCompatible: boolean;
  schemaError: string | null;
  canInstall: boolean;
  updateAvailable: boolean;
  applying: boolean;
  onInstall: () => Promise<void>;
  onUpdate: () => Promise<void>;
}

export default function ReadinessBanner({
  online,
  backendOnline,
  reconnecting,
  dataStale,
  schemaCompatible,
  schemaError,
  canInstall,
  updateAvailable,
  applying,
  onInstall,
  onUpdate,
}: Props) {
  const readOnly = !schemaCompatible || !online || !backendOnline || dataStale;
  if (!readOnly && !canInstall && !updateAvailable) return null;

  const status = !schemaCompatible
    ? { className: 'is-offline', icon: <TriangleAlert aria-hidden="true" />, title: 'Update required', detail: schemaError || 'The backend snapshot schema is incompatible with this interface. Update SMART ATC before issuing commands.' }
    : !online
    ? { className: 'is-offline', icon: <WifiOff aria-hidden="true" />, title: 'Offline cockpit', detail: 'Cached interface only. Live data and controls are read-only; no command or mutation will be queued.' }
    : !backendOnline
      ? { className: 'is-offline', icon: <CloudOff aria-hidden="true" />, title: reconnecting ? 'Reconnecting live services' : 'Live services unavailable', detail: 'The last local view is read-only. Commands remain network-only and will not be replayed later.' }
      : dataStale
        ? { className: 'is-degraded', icon: <TriangleAlert aria-hidden="true" />, title: 'Degraded telemetry', detail: 'The authoritative stream is stale. Treat displayed flight state as read-only until synchronization recovers.' }
        : { className: 'is-ready', icon: <Download aria-hidden="true" />, title: updateAvailable ? 'Cockpit update ready' : 'Install SMART ATC', detail: updateAvailable ? 'A new local interface build is ready to activate.' : 'Install the local application shell for faster launch and offline-safe interface access.' };

  return (
    <aside className={`readiness-banner ${status.className}`} role={schemaCompatible ? 'status' : 'alert'} aria-live={schemaCompatible ? 'polite' : 'assertive'} aria-atomic="true">
      <span className="readiness-banner__icon">{status.icon}</span>
      <div className="readiness-banner__copy"><strong>{status.title}</strong><span>{status.detail}</span></div>
      <div className="readiness-banner__actions">
        {canInstall && <button className="secondary-button" type="button" disabled={applying || !online} onClick={() => void onInstall()}>{applying ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}Install app</button>}
        {updateAvailable && <button className="secondary-button" type="button" disabled={applying} onClick={() => void onUpdate()}>{applying ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}Apply update</button>}
      </div>
    </aside>
  );
}
