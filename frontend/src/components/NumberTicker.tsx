import { useEffect, useRef, useState } from 'react';

interface Props {
  value: number;
  decimals?: number;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
  prefix?: string;
  suffix?: string;
  pad?: number;
}

/** Smoothly animates a numeric value to its new target. */
export default function NumberTicker({
  value,
  decimals = 0,
  duration = 700,
  className,
  style,
  prefix = '',
  suffix = '',
  pad,
}: Props) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const startTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    fromRef.current = display;
    startTimeRef.current = null;

    const step = (ts: number) => {
      if (startTimeRef.current == null) startTimeRef.current = ts;
      const t = Math.min(1, (ts - startTimeRef.current) / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const next = fromRef.current + (value - fromRef.current) * eased;
      setDisplay(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const fixed = display.toFixed(decimals);
  const padded = pad ? fixed.padStart(pad, '0') : fixed;
  return <span className={className} style={style}>{prefix}{padded}{suffix}</span>;
}
