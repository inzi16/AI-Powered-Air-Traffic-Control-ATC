import { useEffect, useRef, useState } from 'react';
import {
  Check,
  LoaderCircle,
  Plane,
  RadioTower,
  SkipForward,
  Volume2,
} from 'lucide-react';
import { playCabinChime, startEngineSpool, stopEngineSpool } from '../utils/sounds';

interface Props {
  onComplete: () => void;
}

const STEPS = [
  'Flight data bus',
  'Navigation model',
  'Traffic surveillance',
  'Emergency intelligence',
  'Controller workspace',
];

const INTRO_SOUND_KEY = 'skycommand:intro-sound';
const REDUCED_MOTION_KEY = 'skycommand:reduced-motion';

function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

export default function IntroScreen({ onComplete }: Props) {
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);
  const callbackRef = useRef(onComplete);
  const startedRef = useRef(false);
  const completedRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    callbackRef.current = onComplete;
  }, [onComplete]);

  // This lifecycle effect is intentionally mount-only. The live callback is held
  // in a ref, so the simulator's frequent rerenders cannot restart the sequence.
  useEffect(() => () => {
    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];
    stopEngineSpool();
  }, []);

  const finish = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];
    stopEngineSpool();
    callbackRef.current();
  };

  const enterCockpit = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStarted(true);

    const systemReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const reducedMotion = readBooleanPreference(REDUCED_MOTION_KEY, systemReducedMotion);
    const soundEnabled = readBooleanPreference(INTRO_SOUND_KEY, true);
    const interval = reducedMotion ? 70 : 360;

    // Audio is only created inside this explicit user gesture.
    if (soundEnabled) {
      playCabinChime();
      if (!reducedMotion) startEngineSpool(3.2);
    }

    STEPS.forEach((_, index) => {
      timersRef.current.push(window.setTimeout(() => setStep(index + 1), interval * (index + 1)));
    });

    const readyAt = interval * STEPS.length + (reducedMotion ? 40 : 220);
    timersRef.current.push(window.setTimeout(() => setReady(true), readyAt));
    timersRef.current.push(window.setTimeout(finish, readyAt + (reducedMotion ? 180 : 760)));
  };

  return (
    <div className="intro-gate" role="dialog" aria-modal="true" aria-labelledby="intro-title">
      <main className="intro-gate__content">
        <div className="intro-gate__kicker">Flight intelligence console</div>

        <div className="intro-gate__brand">
          <span className="brand-mark" aria-hidden="true"><RadioTower /></span>
          <strong id="intro-title">SkyCommand</strong>
        </div>

        <div className="intro-flightpath" aria-hidden="true">
          <span className="intro-plane"><Plane /></span>
        </div>

        {!started ? (
          <>
            <p className="intro-gate__copy">
              Enter the cockpit to start the cabin chime and synchronize navigation,
              surveillance, and controller intelligence.
            </p>
            <div className="intro-gate__actions">
              <button className="primary-button" type="button" onClick={enterCockpit} autoFocus>
                <Volume2 aria-hidden="true" />
                Enter cockpit
              </button>
              <button className="quiet-button" type="button" onClick={finish}>
                <SkipForward aria-hidden="true" />
                Skip intro
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="intro-progress" aria-live="polite" aria-label="Cockpit startup progress">
              {STEPS.map((label, index) => {
                const isDone = index < step;
                const isActive = index === step && !ready;
                const className = `intro-progress__row${isDone ? ' is-done' : ''}${isActive ? ' is-active' : ''}`;
                return (
                  <div className={className} key={label}>
                    <span>{label}</span>
                    {isDone ? (
                      <Check size={14} aria-label="Ready" />
                    ) : isActive ? (
                      <LoaderCircle size={14} className="spin" aria-label="Starting" />
                    ) : (
                      <span aria-label="Waiting">Standby</span>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="intro-gate__copy" aria-live="polite">
              {ready ? 'All systems synchronized. Opening controller workspace.' : 'Synchronizing live flight state.'}
            </p>
            <button className="quiet-button" type="button" onClick={finish}>
              <SkipForward aria-hidden="true" />
              Skip sequence
            </button>
          </>
        )}
      </main>
    </div>
  );
}
