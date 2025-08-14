import { ArrowLeft, Check, Circle, RadioTower, ShieldAlert } from 'lucide-react';
import type { SimData } from '../hooks/useSimData';

interface EmergencyPageProps {
  sim: SimData;
  onBack: () => void;
  ttsEnabled: boolean;
  ttsVoice: string;
}

const STANDBY_ACTIONS = [
  {
    id: 'aviate',
    label: 'Aviate',
    description: 'Maintain aircraft control and verify the live flight state.',
    status: 'pending',
  },
  {
    id: 'navigate',
    label: 'Navigate',
    description: 'Confirm terrain clearance, route, and the nearest suitable landing option.',
    status: 'pending',
  },
  {
    id: 'communicate',
    label: 'Communicate',
    description: 'Declare urgency, set the correct transponder code, and coordinate priority handling.',
    status: 'pending',
  },
];

/**
 * Compatibility route for older App builds. The primary revamp presents this
 * state in-context, but this page remains deterministic and uses backend actions
 * instead of inventing random aircraft systems or emergency outcomes.
 */
export default function EmergencyPage({
  sim,
  onBack,
  ttsEnabled,
  ttsVoice,
}: EmergencyPageProps) {
  const emergency = sim.active_emergency;
  const actions = emergency?.actions.length ? emergency.actions : STANDBY_ACTIONS;
  const title = emergency?.title || (sim.emergency_active ? 'Declared emergency' : 'Emergency command standby');
  const description = emergency?.description
    || 'No structured emergency procedure is active. Start a scenario from the operations console.';
  const voiceLocale = ttsVoice.split('-').slice(0, 2).join('-') || 'default';

  return (
    <div className="intro-gate" role="main" aria-labelledby="emergency-page-title">
      <main className="intro-gate__content">
        <div className="intro-gate__kicker">Emergency command mode</div>
        <div className="intro-gate__brand">
          <span className="brand-mark" aria-hidden="true"><ShieldAlert /></span>
          <strong id="emergency-page-title">{title}</strong>
        </div>
        <p className="intro-gate__copy">{description}</p>

        <section className="emergency-card" aria-label="Prioritized response actions">
          <header className="emergency-card__header">
            <RadioTower aria-hidden="true" />
            <strong>{emergency ? `${emergency.severity} · ${emergency.status}` : 'Procedure preview'}</strong>
          </header>
          <ol className="emergency-steps">
            {actions.map((action, index) => {
              const complete = action.status === 'completed';
              return (
                <li className={`emergency-step${complete ? ' is-complete' : ''}`} key={action.id}>
                  <button type="button" disabled aria-label={complete ? 'Completed' : 'Pending'}>
                    {complete ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
                  </button>
                  <span>
                    <strong>{action.label}</strong>
                    <span>{action.description}</span>
                  </span>
                  <em>{complete ? 'Complete' : `${index + 1} priority`}</em>
                </li>
              );
            })}
          </ol>
        </section>

        <p className="intro-gate__copy mono">
          {sim.callsign || 'Aircraft'} · {Math.round(sim.altitude).toLocaleString()} ft · squawk {sim.squawk}
          {' · '}{ttsEnabled ? `voice guidance ${voiceLocale}` : 'voice guidance off'}
        </p>
        <button className="primary-button" type="button" onClick={onBack} autoFocus>
          <ArrowLeft aria-hidden="true" />
          Return to operations
        </button>
      </main>
    </div>
  );
}
