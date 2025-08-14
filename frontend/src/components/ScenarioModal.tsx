import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, HeartPulse, Loader2, RadioTower, ShieldAlert, Wrench, X } from 'lucide-react';
import type { EmergencyState } from '../hooks/useSimData';

export interface EmergencyScenario {
  type: string;
  name: string;
  description: string;
  severity?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  scenarios: EmergencyScenario[];
  activeEmergency?: EmergencyState | null;
  onActivate: (type: string, details?: string, autoDivert?: boolean) => Promise<void>;
  onCompleteAction: (emergencyId: string, actionId: string) => Promise<void>;
  onResolve: (emergencyId: string) => Promise<void>;
  busy?: boolean;
  error?: string | null;
}

const DEFAULT_SCENARIOS: EmergencyScenario[] = [
  { type: 'engine_failure', name: 'Engine failure', description: 'Power loss with glide, diversion and landing workflow.', severity: 'distress' },
  { type: 'smoke_fire', name: 'Smoke or fire', description: 'Time-critical isolation, descent and nearest suitable landing.', severity: 'catastrophic' },
  { type: 'medical', name: 'Medical emergency', description: 'Priority handling, suitable airport and ground coordination.', severity: 'urgent' },
  { type: 'hydraulic', name: 'Hydraulic failure', description: 'System isolation and landing configuration management.', severity: 'distress' },
  { type: 'comm_failure', name: 'Communication failure', description: 'Squawk 7600 and predictable route/altitude procedures.', severity: 'urgent' },
  { type: 'fuel', name: 'Fuel emergency', description: 'Fuel protection, diversion and minimum-fuel decision gates.', severity: 'distress' },
  { type: 'bird_strike', name: 'Bird strike', description: 'Damage assessment, performance check and recovery plan.', severity: 'urgent' },
  { type: 'gear', name: 'Landing gear issue', description: 'Extension verification and abnormal landing preparation.', severity: 'distress' },
];

export default function ScenarioModal({ open, onClose, scenarios, activeEmergency, onActivate, onCompleteAction, onResolve, busy = false, error }: Props) {
  const [selected, setSelected] = useState('engine_failure');
  const [details, setDetails] = useState('');
  const [autoDivert, setAutoDivert] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const options = scenarios.length ? scenarios : DEFAULT_SCENARIOS;

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <div className="modal-panel emergency-modal" role="dialog" aria-modal="true" aria-labelledby="emergency-modal-title" tabIndex={-1} ref={dialogRef}>
        <header className="modal-header">
          <div><span className="eyebrow">Training simulator</span><h2 id="emergency-modal-title">Emergency command center</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close emergency simulator"><X aria-hidden="true" /></button>
        </header>
        <div className="modal-copy">
          <div className="training-notice"><ShieldAlert aria-hidden="true" /><div><strong>Simulation and training use only</strong><span>Guidance is state-driven and must never replace an aircraft checklist, qualified crew or operational ATC.</span></div></div>

          {activeEmergency ? (
            <section className="active-emergency-workflow">
              <header><span className="emergency-type-icon"><AlertTriangle aria-hidden="true" /></span><div><span className="eyebrow">{activeEmergency.severity} - {activeEmergency.status}</span><h3>{activeEmergency.title}</h3><p>{activeEmergency.description}</p></div></header>
              <ol className="emergency-action-list">
                {activeEmergency.actions.map((action) => {
                  const complete = action.status === 'completed';
                  return <li key={action.id} className={complete ? 'is-complete' : ''}><button type="button" disabled={busy || complete} onClick={() => onCompleteAction(activeEmergency.id, action.id)} aria-label={`${complete ? 'Completed' : 'Complete'} ${action.label}`}>{complete ? <CheckCircle2 aria-hidden="true" /> : <span>{action.priority}</span>}</button><div><strong>{action.label}</strong><p>{action.description}</p><small>{action.category}</small></div></li>;
                })}
              </ol>
              {activeEmergency.resolution_criteria?.length ? (
                <section className="resolution-gates">
                  <span className="eyebrow">Resolution gates</span>
                  <ul>{activeEmergency.resolution_criteria.map((criterion) => <li key={criterion.criterion_id} className={criterion.satisfied ? 'is-satisfied' : ''}>{criterion.satisfied ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}<span>{criterion.description}</span></li>)}</ul>
                </section>
              ) : null}
              {error && <div className="form-error" role="alert">{error}</div>}
              <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Keep monitoring</button><button className="primary-button" type="button" disabled={busy || activeEmergency.can_resolve === false || activeEmergency.actions.some((action) => action.requires_confirmation && action.status !== 'completed')} onClick={() => onResolve(activeEmergency.id)}>{busy ? <Loader2 className="spin" /> : <CheckCircle2 />}Resolve after criteria</button></div>
            </section>
          ) : (
            <>
              <p>Select a failure to inject. The simulator will raise the correct UI alarm, protect the flight state, create prioritized actions and optionally divert to a suitable airport.</p>
              <div className="emergency-preset-grid">
                {options.map((scenario) => (
                  <button className={`emergency-preset ${selected === scenario.type ? 'is-selected' : ''}`} type="button" key={scenario.type} onClick={() => setSelected(scenario.type)}>
                    <span className="emergency-type-icon">{scenario.type === 'medical' ? <HeartPulse /> : scenario.type === 'comm_failure' ? <RadioTower /> : scenario.type === 'hydraulic' || scenario.type === 'gear' ? <Wrench /> : <AlertTriangle />}</span>
                    <span><strong>{scenario.name}</strong><small>{scenario.description}</small></span>
                  </button>
                ))}
              </div>
              <label className="form-field"><span>Scenario detail (optional)</span><textarea value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Example: failure during climb with deteriorating weather" /></label>
              <label className="toggle-row"><input type="checkbox" checked={autoDivert} onChange={(event) => setAutoDivert(event.target.checked)} /><span><strong>Automatically compute a diversion</strong><small>Chooses a suitable training airport using range, runway and route geometry.</small></span></label>
              {error && <div className="form-error" role="alert">{error}</div>}
              <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="danger-button" type="button" disabled={busy} onClick={() => onActivate(selected, details.trim() || undefined, autoDivert)}>{busy ? <Loader2 className="spin" /> : <ShieldAlert />}Inject emergency</button></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
