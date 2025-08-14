export function formatAltitude(alt: number): string {
  if (alt >= 18000) {
    return `FL${Math.round(alt / 100)}`;
  }
  return `${alt.toLocaleString()} ft`;
}

export function formatSpeed(spd: number): string {
  return `${spd} kts`;
}

export function formatHeading(hdg: number): string {
  return `${String(hdg).padStart(3, '0')}°`;
}

export function formatPosition(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns} ${Math.abs(lon).toFixed(4)}°${ew}`;
}

export function formatFrequency(freq: number): string {
  return freq ? freq.toFixed(3) : '---';
}

export function getPhaseColor(phase: string): string {
  const map: Record<string, string> = {
    AT_GATE: '#64748b',
    PUSHBACK: '#8b5cf6',
    TAXI: '#d97706',
    HOLDING_SHORT: '#f59e0b',
    TAKEOFF_ROLL: '#dc2626',
    INITIAL_CLIMB: '#ea580c',
    CLIMB: '#2563eb',
    CRUISE: '#16a34a',
    DESCENT: '#0891b2',
    APPROACH: '#7c3aed',
    FINAL_APPROACH: '#be185d',
    LANDING: '#dc2626',
    LANDED: '#16a34a',
    UNKNOWN: '#94a3b8',
  };
  return map[phase] || '#94a3b8';
}

export function getTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function isEmergencySquawk(squawk: string): boolean {
  return ['7500', '7600', '7700'].includes(squawk);
}

export function getSquawkMeaning(squawk: string): string | null {
  const map: Record<string, string> = {
    '7500': 'HIJACK',
    '7600': 'COMM FAILURE',
    '7700': 'EMERGENCY',
  };
  return map[squawk] || null;
}
