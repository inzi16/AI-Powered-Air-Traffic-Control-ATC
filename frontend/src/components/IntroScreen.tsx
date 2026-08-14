import { useCallback, useEffect, useRef, useState } from 'react';
import { Plane } from 'lucide-react';
import { playCabinChime, startEngineSpool, stopEngineSpool } from '../utils/sounds';

interface Props {
  onHandoffStart?: () => void;
  onComplete: () => void;
}

const INTRO_SOUND_KEY = 'skycommand:intro-sound';
const START_DELAY_MS = 120;
const TAKEOFF_DURATION_MS = 4_250;
const HANDOFF_START_MS = 3_300;
const HANDOFF_DURATION_MS = 960;

function readSoundPreference(): boolean {
  try {
    const value = window.localStorage.getItem(INTRO_SOUND_KEY);
    return value === null ? true : value === 'true';
  } catch {
    return true;
  }
}

export default function IntroScreen({ onHandoffStart, onComplete }: Props) {
  const [running, setRunning] = useState(false);
  const [exiting, setExiting] = useState(false);
  const callbackRef = useRef(onComplete);
  const handoffCallbackRef = useRef(onHandoffStart);
  const completedRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    callbackRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    handoffCallbackRef.current = onHandoffStart;
  }, [onHandoffStart]);

  const finish = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];
    stopEngineSpool();
    callbackRef.current();
  }, []);

  useEffect(() => {
    // A short mount delay lets the first frame paint before compositor-only
    // transforms begin, and also keeps React development remounts silent.
    timersRef.current.push(window.setTimeout(() => {
      setRunning(true);
      if (readSoundPreference()) {
        playCabinChime();
        startEngineSpool(TAKEOFF_DURATION_MS / 1_000);
      }
    }, START_DELAY_MS));
    timersRef.current.push(window.setTimeout(() => {
      setExiting(true);
      handoffCallbackRef.current?.();
    }, START_DELAY_MS + HANDOFF_START_MS));

    return () => {
      timersRef.current.forEach(window.clearTimeout);
      timersRef.current = [];
      stopEngineSpool();
    };
  }, []);

  useEffect(() => {
    if (!exiting) return undefined;
    const fallback = window.setTimeout(finish, HANDOFF_DURATION_MS + 600);
    return () => window.clearTimeout(fallback);
  }, [exiting, finish]);

  return (
    <div
      className={`intro-gate${running ? ' is-running' : ''}${exiting ? ' is-exiting' : ''}`}
      role="img"
      aria-label="Smart ATC aircraft departure"
      onAnimationEnd={(event) => {
        if (exiting && event.target === event.currentTarget && event.animationName === 'intro-gate-release') finish();
      }}
    >
      <main className="intro-gate__content">
        <header className="intro-gate__masthead">
          <span className="intro-gate__kicker">Live aviation operations</span>
          <div className="intro-gate__brand">
            <strong>SMART ATC</strong>
            <span>Controller workspace</span>
          </div>
        </header>

        <div className="intro-takeoff" aria-hidden="true">
          <span className="intro-takeoff__sky-glow" />
          <span className="intro-takeoff__horizon" />

          <div className="intro-runway">
            <span /><span /><span /><span /><span /><span />
          </div>

          <span className="intro-orbit"><i /></span>

          <div className="intro-aircraft">
            <span className="intro-aircraft__trail intro-aircraft__trail--cool" />
            <span className="intro-aircraft__trail intro-aircraft__trail--warm" />
            <span className="intro-aircraft__shadow" />
            <span className="intro-aircraft__body"><Plane strokeWidth={1.35} /></span>
          </div>
        </div>

      </main>
      <span className="intro-signal" aria-hidden="true" />
    </div>
  );
}
