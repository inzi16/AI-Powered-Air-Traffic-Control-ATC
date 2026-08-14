import { Clock3, Gauge, LoaderCircle, Pause, Play } from 'lucide-react';
import type { ScenarioControlState } from '../types/sim';

const TIME_SCALES = [0.25, 0.5, 1, 2, 4, 8, 12, 20, 40, 60, 120];

interface Props {
  control: ScenarioControlState;
  disabled?: boolean;
  busy?: boolean;
  error?: string | null;
  onToggle: () => void;
  onTimeScaleChange: (timeScale: number) => void;
}

function formatSimulationTime(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const remainder = wholeSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
}

export default function ScenarioControlBar({ control, disabled = false, busy = false, error, onToggle, onTimeScaleChange }: Props) {
  const timeScales = [...new Set([...TIME_SCALES, control.time_scale])].sort((a, b) => a - b);
  return (
    <div className={`scenario-control-bar ${control.paused ? 'is-paused' : ''}`} role="group" aria-label="Live scenario controls">
      <button
        className="scenario-control-toggle"
        type="button"
        onClick={onToggle}
        disabled={disabled || busy}
        aria-label={control.paused ? 'Resume live simulation' : 'Pause live simulation'}
        title={control.paused ? 'Resume live simulation' : 'Pause live simulation'}
      >
        {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : control.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        <span>{control.paused ? 'Resume' : 'Pause'}</span>
      </button>
      <label className="scenario-speed" title="Live simulation time scale">
        <Gauge aria-hidden="true" />
        <span className="sr-only">Live simulation time scale</span>
        <select value={control.time_scale} disabled={disabled || busy} onChange={(event) => onTimeScaleChange(Number(event.target.value))}>
          {timeScales.map((scale) => <option key={scale} value={scale}>{scale}×</option>)}
        </select>
      </label>
      <span className="scenario-clock" title="Elapsed simulation time"><Clock3 aria-hidden="true" />{formatSimulationTime(control.simulation_time_seconds)}</span>
      {error && <span className="sr-only" role="alert">{error}</span>}
    </div>
  );
}
