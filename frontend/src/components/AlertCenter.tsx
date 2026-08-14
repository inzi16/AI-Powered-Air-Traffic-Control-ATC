import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, BellRing, Check, CloudSun, Info, LoaderCircle, Radio, RotateCcw, ShieldAlert, X } from 'lucide-react';
import type { OperationalAlert, OperationalAlertCategory, OperationalAlertSeverity } from '../utils/operationalAlerts';

interface Props {
  open: boolean;
  alerts: OperationalAlert[];
  acknowledgedIds: ReadonlySet<string>;
  pendingIds: ReadonlySet<string>;
  authoritativeReadOnly: boolean;
  onAcknowledge: (id: string) => void;
  onUnacknowledge: (id: string) => void;
  onAcknowledgeAll: (ids: string[]) => void;
  onInspect: (alert: OperationalAlert) => void;
  onClose: () => void;
}

function AlertIcon({ category }: { category: OperationalAlertCategory }): ReactNode {
  if (category === 'emergency') return <ShieldAlert aria-hidden="true" />;
  if (category === 'traffic') return <Radio aria-hidden="true" />;
  if (category === 'weather') return <CloudSun aria-hidden="true" />;
  if (category === 'system') return <Info aria-hidden="true" />;
  return <AlertTriangle aria-hidden="true" />;
}

function displayTime(value: string | null): string {
  if (!value) return 'NOW';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'NOW' : `${parsed.toISOString().slice(11, 19)}Z`;
}

function isFocusable(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && !element.hasAttribute('disabled') && element.tabIndex !== -1;
}

export default function AlertCenter({ open, alerts, acknowledgedIds, pendingIds, authoritativeReadOnly, onAcknowledge, onUnacknowledge, onAcknowledgeAll, onInspect, onClose }: Props) {
  const [severity, setSeverity] = useState<'all' | OperationalAlertSeverity>('all');
  const [category, setCategory] = useState<'all' | OperationalAlertCategory>('all');
  const [unacknowledgedOnly, setUnacknowledgedOnly] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const filtered = useMemo(() => alerts.filter((alert) => {
    const acknowledged = acknowledgedIds.has(alert.id);
    return (severity === 'all' || alert.severity === severity)
      && (category === 'all' || alert.category === category)
      && (!unacknowledgedOnly || !acknowledged);
  }), [acknowledgedIds, alerts, category, severity, unacknowledgedOnly]);

  const unacknowledged = alerts.filter((alert) => alert.requiresAcknowledgement && !acknowledgedIds.has(alert.id));
  const actionableUnacknowledged = unacknowledged.filter((alert) => alert.acknowledgementScope === 'local' || !authoritativeReadOnly);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('button, select, input')?.focus());
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll('button, select, input, [tabindex]')].filter(isFocusable);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="alert-center-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="alert-center" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <header className="alert-center__header">
          <span className="alert-center__heading-icon"><BellRing aria-hidden="true" /></span>
          <div><span className="eyebrow">Live operations</span><h2 id={titleId}>Alert center</h2></div>
          <span className="alert-center__count">{unacknowledged.length} unacknowledged</span>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close alert center"><X aria-hidden="true" /></button>
        </header>

        <div className="alert-center__filters" aria-label="Alert filters">
          <label><span>Severity</span><select value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)}><option value="all">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="caution">Caution</option><option value="info">Information</option></select></label>
          <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="all">All categories</option><option value="emergency">Emergency</option><option value="traffic">Traffic</option><option value="weather">Weather</option><option value="flight">Flight</option><option value="system">System</option></select></label>
          <label className="alert-toggle"><input type="checkbox" checked={unacknowledgedOnly} onChange={(event) => setUnacknowledgedOnly(event.target.checked)} /><span>Unacknowledged only</span></label>
          <button className="secondary-button" type="button" disabled={!actionableUnacknowledged.length} onClick={() => onAcknowledgeAll(actionableUnacknowledged.map((alert) => alert.id))}><Check aria-hidden="true" />Acknowledge all</button>
        </div>

        <div className="alert-list" aria-live="polite">
          {filtered.map((alert) => {
            const acknowledged = acknowledgedIds.has(alert.id);
            const pending = pendingIds.has(alert.id);
            const backendUnavailable = alert.acknowledgementScope === 'authoritative' && authoritativeReadOnly;
            return (
              <article className={`alert-item is-${alert.severity} ${acknowledged ? 'is-acknowledged' : ''}`} key={alert.id}>
                <span className="alert-item__icon"><AlertIcon category={alert.category} /></span>
                <div className="alert-item__copy"><div><strong>{alert.title}</strong><time>{displayTime(alert.createdAt)}</time></div><p>{alert.message}</p><span>{alert.category} · {alert.severity} · {alert.acknowledgementScope === 'authoritative' ? 'backend ACK' : 'local ACK'}</span></div>
                <div className="alert-item__actions">
                  <button className="quiet-button" type="button" onClick={() => onInspect(alert)}>Inspect</button>
                  {!alert.requiresAcknowledgement
                    ? <button className="secondary-button" type="button" disabled>No ACK required</button>
                    : acknowledged
                      ? <button className="secondary-button" type="button" disabled={pending || backendUnavailable} onClick={() => onUnacknowledge(alert.id)}>{pending ? <LoaderCircle className="spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}Unacknowledge</button>
                      : <button className="secondary-button" type="button" disabled={pending || backendUnavailable} onClick={() => onAcknowledge(alert.id)}>{pending ? <LoaderCircle className="spin" aria-hidden="true" /> : null}Acknowledge</button>}
                </div>
              </article>
            );
          })}
          {!filtered.length && <div className="alert-empty"><Check aria-hidden="true" /><strong>No alerts match these filters</strong><span>Live safety monitors remain active.</span></div>}
        </div>
        <footer className="alert-center__footer"><span>Backend alert ACKs persist in this training room; connectivity and data-quality ACKs remain local.</span><span>Source: synchronized authoritative state</span></footer>
      </section>
    </div>
  );
}
