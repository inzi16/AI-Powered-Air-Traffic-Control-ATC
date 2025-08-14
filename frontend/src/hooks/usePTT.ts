import { useEffect, useRef } from 'react';

function normalizedPttCode(key: string): string {
  // Older saved settings used Tab. Preserve keyboard navigation by migrating
  // that value at the interaction boundary instead of ever intercepting Tab.
  return !key || key === 'Tab' ? 'Space' : key;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest(
    'input, textarea, select, button, a[href], summary, [contenteditable="true"], [role="textbox"], [role="button"]',
  ));
}

export function usePTT(
  key: string,
  onStart: () => void,
  onStop: () => void,
  enabled = true,
) {
  const keyRef = useRef(normalizedPttCode(key));
  const startRef = useRef(onStart);
  const stopRef = useRef(onStop);
  const enabledRef = useRef(enabled);
  const activeRef = useRef(false);

  useEffect(() => {
    const nextKey = normalizedPttCode(key);
    const keyChanged = nextKey !== keyRef.current;
    keyRef.current = nextKey;
    startRef.current = onStart;
    stopRef.current = onStop;
    enabledRef.current = enabled;

    if ((!enabled || keyChanged) && activeRef.current) {
      activeRef.current = false;
      stopRef.current();
    }
  }, [enabled, key, onStart, onStop]);

  useEffect(() => {
    const release = () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      stopRef.current();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!enabledRef.current || event.repeat || event.code === 'Tab') return;
      if (event.code !== keyRef.current || activeRef.current || isInteractiveTarget(event.target)) return;
      event.preventDefault();
      activeRef.current = true;
      startRef.current();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Tab' || event.code !== keyRef.current || !activeRef.current) return;
      event.preventDefault();
      release();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') release();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      release();
    };
  }, []);
}
