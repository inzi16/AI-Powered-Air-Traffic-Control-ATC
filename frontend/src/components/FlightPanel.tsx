import {
  Activity,
  ArrowLeftRight,
  ArrowRight,
  Compass,
  Fuel,
  Gauge,
  MapPin,
  Navigation,
  Plane,
  Route,
} from 'lucide-react';
import type { SimData, TrafficContact } from '../hooks/useSimData';

interface RouteSummary {
  origin_icao?: string;
  destination_icao?: string;
  progress_pct?: number;
  distance_remaining_nm?: number;
  eta_minutes?: number;
}

type EnrichedSimData = SimData & {
  route?: RouteSummary | null;
  source?: string;
  data_quality?: Record<string, string>;
};

interface FlightPanelProps {
  sim: EnrichedSimData;
  className?: string;
  onPlanRoute?: () => void;
}

function formatAltitude(altitude: number): string {
  if (!Number.isFinite(altitude)) return '—';
  return altitude >= 18_000 ? `FL ${Math.round(altitude / 100).toString().padStart(3, '0')}` : `${Math.round(altitude).toLocaleString()} ft`;
}

function qualityClass(sim: EnrichedSimData, key: string): string {
  const quality = sim.data_quality?.[key];
  if (quality === 'stale') return 'is-stale';
  if (quality === 'unavailable' || quality === 'unknown') return 'is-unavailable';
  return '';
}

function sourceLabel(sim: EnrichedSimData, key: string): string {
  if (sim.sequence <= 0 || sim.timestamps.received_at_ms <= 0) return 'N/A';
  const quality = sim.data_quality?.[key];
  if (quality === 'unavailable' || quality === 'unknown') return 'N/A';
  if (quality === 'stale') return 'STALE';
  if (sim.source === 'simconnect') return 'SIM';
  if (['demo', 'scenario', 'synthetic', 'preview'].includes(sim.source)) return 'DEMO';
  return 'LIVE';
}

export default function FlightPanel({ sim, className = '', onPlanRoute }: FlightPanelProps) {
  const hasSnapshot = sim.sequence > 0 && sim.timestamps.received_at_ms > 0;
  const callsign = sim.callsign || `${sim.atc_id || ''}${sim.atc_flight_number || ''}` || 'NO FLIGHT';
  const origin = sim.route?.origin_icao || '----';
  const destination = sim.route?.destination_icao || '----';
  const emergency = Boolean(sim.emergency_active) || ['7500', '7600', '7700'].includes(sim.squawk);
  const conflict = sim.conflicts?.[0];
  const conflictTraffic = conflict ? sim.traffic?.find((item) => item.callsign === conflict.callsign) : undefined;

  return (
    <aside className={`flight-rail ${className}`} aria-label="Active flight details">
      <section className="flight-identity">
        <div className="flight-identity__top">
          <span className="eyebrow">Active flight</span>
          <button className="quiet-button" type="button" onClick={onPlanRoute} aria-label="Change route"><Route size={16} aria-hidden="true" /></button>
        </div>
        <h1 className="flight-callsign">{callsign}</h1>
        <div className="flight-route"><span>{origin}</span><ArrowRight aria-hidden="true" /><span>{destination}</span></div>
        <div className="scenario-chip"><span className="mode-dot" />{sim.active_scenario || (sim.source === 'simconnect' ? 'Simulator feed' : sim.route ? 'Synchronized demo' : 'Training preview')}</div>
      </section>

      <section className="phase-block" aria-label={`Flight phase ${sim.phase_label || sim.phase}`}>
        <div className="phase-icon"><Plane aria-hidden="true" /></div>
        <div>
          <div className="eyebrow">Flight phase</div>
          <div className="phase-value">{sim.phase_label || sim.phase || 'Unknown'}</div>
          <div className="phase-detail">
            {sim.route?.progress_pct != null ? `${Math.round(sim.route.progress_pct)}% complete` : sim.on_ground ? 'Ground operations' : 'Airborne'}
          </div>
        </div>
      </section>

      <div className="metric-list">
        <Metric icon={<Navigation />} label="Altitude" value={hasSnapshot ? formatAltitude(sim.altitude) : 'Not reported'} source={sourceLabel(sim, 'altitude')} sourceClass={hasSnapshot ? qualityClass(sim, 'altitude') : 'is-unavailable'} />
        <Metric icon={<Gauge />} label="Ground speed" value={hasSnapshot ? `${Math.round(sim.ground_speed || 0)} kt` : 'Not reported'} source={sourceLabel(sim, 'ground_speed')} sourceClass={hasSnapshot ? qualityClass(sim, 'ground_speed') : 'is-unavailable'} />
        <Metric icon={<Compass />} label="Heading" value={hasSnapshot ? `${String(Math.round(sim.heading_mag || 0)).padStart(3, '0')}°` : 'Not reported'} source={sourceLabel(sim, 'heading_mag')} sourceClass={hasSnapshot ? qualityClass(sim, 'heading_mag') : 'is-unavailable'} />
        <Metric icon={<Activity />} label="Vertical speed" value={hasSnapshot ? `${Math.round(sim.vertical_speed_fpm || sim.vertical_rate || 0)} fpm` : 'Not reported'} source={sourceLabel(sim, 'vertical_speed_fpm')} sourceClass={hasSnapshot ? qualityClass(sim, 'vertical_speed_fpm') : 'is-unavailable'} />
        <Metric icon={<MapPin />} label="Position" value={hasSnapshot ? `${Math.abs(sim.lat || 0).toFixed(4)}°${(sim.lat || 0) >= 0 ? 'N' : 'S'} ${Math.abs(sim.lon || 0).toFixed(4)}°${(sim.lon || 0) >= 0 ? 'E' : 'W'}` : 'Not reported'} source={sourceLabel(sim, 'position')} sourceClass={hasSnapshot ? qualityClass(sim, 'position') : 'is-unavailable'} />
        <Metric icon={<Fuel />} label="Fuel remaining" value={sim.fuel_kg > 0 ? `${Math.round(sim.fuel_kg).toLocaleString()} kg` : 'Not reported'} source={sourceLabel(sim, 'fuel_kg')} sourceClass={sim.fuel_kg > 0 ? qualityClass(sim, 'fuel_kg') : 'is-unavailable'} />
      </div>

      {conflictTraffic && <TrafficStrip traffic={conflictTraffic} ownship={callsign} />}

      <section className={`flight-status ${emergency ? 'is-emergency' : conflict ? 'is-warning' : ''}`}>
        <span className="eyebrow">Status</span>
        <strong>{emergency ? 'Emergency active' : conflict ? 'Traffic advisory' : 'Normal'}</strong>
        <p>
          {emergency
            ? 'Use the emergency coach and complete the priority actions.'
            : conflict
              ? `${conflict.callsign} projected within ${conflict.range_nm.toFixed(1)} NM.`
              : sim.route?.distance_remaining_nm != null
                ? `${Math.round(sim.route.distance_remaining_nm)} NM remaining · ${Math.max(1, Math.round((sim.route.wall_clock_eta_seconds ?? sim.route.eta_seconds ?? (sim.route.eta_minutes || 0) * 60) / 60))} min demo ETA`
                : 'All monitored systems nominal.'}
        </p>
      </section>
    </aside>
  );
}

function Metric({ icon, label, value, source, sourceClass = '' }: { icon: React.ReactNode; label: string; value: string; source: string; sourceClass?: string }) {
  return (
    <div className="metric-row">
      <div className="metric-icon" aria-hidden="true">{icon}</div>
      <div>
        <div className="eyebrow">{label}</div>
        <div className="metric-value">{value}</div>
      </div>
      <span className={`metric-source ${sourceClass}`}>{source}</span>
    </div>
  );
}

function TrafficStrip({ traffic, ownship }: { traffic: TrafficContact; ownship: string }) {
  return (
    <section className="traffic-strip" aria-label={`Conflicting traffic ${traffic.callsign}`}>
      <div className="traffic-strip__bar" />
      <div className="eyebrow">Conflict pair</div>
      <div className="traffic-strip__title"><strong>{ownship}</strong><ArrowLeftRight aria-hidden="true" /><strong>{traffic.callsign}</strong></div>
      <div className="traffic-strip__data mono">
        <span>{formatAltitude(traffic.altitude)}</span>
        <span>{Math.round(traffic.speed)} kt</span>
        <span>{String(Math.round(traffic.heading)).padStart(3, '0')}°</span>
      </div>
    </section>
  );
}
