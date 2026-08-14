export type AltitudeBand = 'all' | 'low' | 'mid' | 'high';

export interface SurveillanceFilters {
  showTraffic: boolean;
  conflictsOnly: boolean;
  altitudeBand: AltitudeBand;
  showRoute: boolean;
  showTrail: boolean;
}

export const DEFAULT_SURVEILLANCE_FILTERS: SurveillanceFilters = {
  showTraffic: true,
  conflictsOnly: false,
  altitudeBand: 'all',
  showRoute: true,
  showTrail: true,
};

export function matchesAltitudeBand(altitude: number, band: AltitudeBand): boolean {
  if (band === 'low') return altitude < 10_000;
  if (band === 'mid') return altitude >= 10_000 && altitude < 24_000;
  if (band === 'high') return altitude >= 24_000;
  return true;
}
