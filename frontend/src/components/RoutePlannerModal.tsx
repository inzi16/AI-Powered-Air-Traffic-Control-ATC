import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Globe2, Loader2, MapPin, PlaneTakeoff, Search, X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';

export interface AirportOption {
  icao: string;
  name?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
  elev?: number;
}

export type ManualAirportInput = Omit<AirportOption, 'icao'>;

export interface DemoRouteRequest {
  origin_icao: string;
  destination_icao: string;
  origin?: ManualAirportInput;
  destination?: ManualAirportInput;
  cruise_altitude_ft: number;
  cruise_speed_kts: number;
  time_scale: number;
  auto_start: boolean;
  callsign?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSearch: (query: string) => Promise<AirportOption[]>;
  onStart: (request: DemoRouteRequest) => Promise<void>;
  callsign?: string;
  busy?: boolean;
  error?: string | null;
  readOnly?: boolean;
}

const PRESETS = [
  { origin: 'VOMM', destination: 'VOBL', label: 'Chennai to Bengaluru', detail: 'Regional departure and arrival' },
  { origin: 'VIDP', destination: 'VABB', label: 'Delhi to Mumbai', detail: 'High-altitude domestic sector' },
  { origin: 'EGLL', destination: 'KJFK', label: 'London to New York', detail: 'Long-haul accelerated demo' },
  { origin: 'WSSS', destination: 'RJTT', label: 'Singapore to Tokyo', detail: 'International operations' },
];

function coordinatePairValid(coords: { lat: string; lon: string }): boolean {
  const bothBlank = coords.lat.trim() === '' && coords.lon.trim() === '';
  if (bothBlank) return true;
  const lat = Number(coords.lat);
  const lon = Number(coords.lon);
  return coords.lat.trim() !== '' && coords.lon.trim() !== ''
    && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function airportCodeValid(value: string): boolean {
  return /^[A-Z0-9]{3,5}$/.test(value.trim().toUpperCase());
}

export default function RoutePlannerModal({ open, onClose, onSearch, onStart, callsign, busy = false, error, readOnly = false }: Props) {
  const [origin, setOrigin] = useState('VOMM');
  const [destination, setDestination] = useState('VOBL');
  const [altitude, setAltitude] = useState(12_000);
  const [speed, setSpeed] = useState(260);
  const [timeScale, setTimeScale] = useState(20);
  const [manual, setManual] = useState(false);
  const [originCoords, setOriginCoords] = useState({ lat: '', lon: '' });
  const [destinationCoords, setDestinationCoords] = useState({ lat: '', lon: '' });
  const [suggestions, setSuggestions] = useState<AirportOption[]>([]);
  const [activeField, setActiveField] = useState<'origin' | 'destination' | null>(null);
  const [searching, setSearching] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, onClose, dialogRef);

  useEffect(() => {
    const query = activeField === 'origin' ? origin : activeField === 'destination' ? destination : '';
    if (!open || query.trim().length < 2) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      onSearch(query.trim()).then((result) => { if (!cancelled) setSuggestions(result.slice(0, 8)); }).catch(() => { if (!cancelled) setSuggestions([]); }).finally(() => { if (!cancelled) setSearching(false); });
    }, 240);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activeField, destination, onSearch, open, origin]);

  const manualCoordinatesValid = !manual || (coordinatePairValid(originCoords) && coordinatePairValid(destinationCoords));
  const airportCodesValid = airportCodeValid(origin) && airportCodeValid(destination);
  const canSubmit = useMemo(() => (
    airportCodesValid
    && origin.trim().toUpperCase() !== destination.trim().toUpperCase()
    && manualCoordinatesValid
  ), [airportCodesValid, destination, manualCoordinatesValid, origin]);
  const activeQuery = activeField === 'origin' ? origin : activeField === 'destination' ? destination : '';
  const visibleSuggestions = activeQuery.trim().length >= 2 ? suggestions : [];

  if (!open) return null;

  const chooseAirport = (airport: AirportOption) => {
    if (activeField === 'origin') {
      setOrigin(airport.icao);
      if (airport.lat != null && airport.lon != null) setOriginCoords({ lat: String(airport.lat), lon: String(airport.lon) });
    } else {
      setDestination(airport.icao);
      if (airport.lat != null && airport.lon != null) setDestinationCoords({ lat: String(airport.lat), lon: String(airport.lon) });
    }
    setSuggestions([]);
    setActiveField(null);
  };

  const buildAirport = (icao: string, coords: { lat: string; lon: string }): ManualAirportInput | undefined => {
    if (!manual || coords.lat.trim() === '' || coords.lon.trim() === '') return undefined;
    const lat = Number(coords.lat);
    const lon = Number(coords.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { name: `${icao} manual airport`, lat, lon } : undefined;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || busy || readOnly) return;
    await onStart({
      origin_icao: origin.trim().toUpperCase(),
      destination_icao: destination.trim().toUpperCase(),
      origin: buildAirport(origin.trim().toUpperCase(), originCoords),
      destination: buildAirport(destination.trim().toUpperCase(), destinationCoords),
      cruise_altitude_ft: altitude,
      cruise_speed_kts: speed,
      time_scale: timeScale,
      auto_start: true,
      callsign: callsign?.trim() || undefined,
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="route-planner-title" tabIndex={-1} ref={dialogRef}>
        <header className="modal-header">
          <div><span className="eyebrow">Global flight demo</span><h2 id="route-planner-title">Plan any airport-to-airport route</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close route planner" data-dialog-initial-focus><X aria-hidden="true" /></button>
        </header>
        <form className="modal-copy" onSubmit={submit}>
          <p>The flight engine will interpolate a geodesic route, manage heading, altitude, speed, phase transitions and arrival. Use coordinates when an airport is not in the local catalog.</p>
          <div className="preset-grid">
            {PRESETS.map((preset) => (
              <button className={`preset-card ${origin === preset.origin && destination === preset.destination ? 'is-selected' : ''}`} type="button" key={preset.label} onClick={() => { setOrigin(preset.origin); setDestination(preset.destination); }}>
                <strong>{preset.origin} <ArrowRight size={14} aria-hidden="true" /> {preset.destination}</strong>
                <span>{preset.label}<br />{preset.detail}</span>
              </button>
            ))}
          </div>

          <div className="route-pair">
            <AirportField label="Origin" value={origin} icon={<PlaneTakeoff />} active={activeField === 'origin'} searching={searching && activeField === 'origin'} onFocus={() => setActiveField('origin')} onChange={setOrigin} />
            <ArrowRight className="route-pair__arrow" aria-hidden="true" />
            <AirportField label="Destination" value={destination} icon={<MapPin />} active={activeField === 'destination'} searching={searching && activeField === 'destination'} onFocus={() => setActiveField('destination')} onChange={setDestination} />
          </div>
          {visibleSuggestions.length > 0 && activeField && (
            <div className="airport-results" role="listbox" aria-label={`${activeField} airport suggestions`}>
              {visibleSuggestions.map((airport) => <button type="button" role="option" key={`${activeField}-${airport.icao}`} onClick={() => chooseAirport(airport)}><strong>{airport.icao}</strong><span>{[airport.name, airport.city, airport.country].filter(Boolean).join(' - ')}</span></button>)}
            </div>
          )}
          {!airportCodesValid && <div className="form-error" role="status">Select an airport result or enter a 3-5 character ICAO code.</div>}

          <button className="manual-toggle" type="button" aria-expanded={manual} onClick={() => setManual((current) => !current)}><Globe2 aria-hidden="true" />{manual ? 'Hide manual coordinates' : 'Airport not found? Enter coordinates'}</button>
          {manual && (
            <>
              <div className="form-grid coordinate-grid">
                <CoordinateFields prefix="Origin" value={originCoords} onChange={setOriginCoords} />
                <CoordinateFields prefix="Destination" value={destinationCoords} onChange={setDestinationCoords} />
              </div>
              {!manualCoordinatesValid && <div className="form-error" role="alert">Enter both latitude and longitude for each manual airport, within valid geographic ranges.</div>}
            </>
          )}

          <div className="form-grid route-parameters">
            <label className="form-field"><span>Cruise altitude</span><input type="number" min={3000} max={45000} step={1000} value={altitude} onChange={(event) => setAltitude(Number(event.target.value))} /><small className="form-help">3,000 to 45,000 ft</small></label>
            <label className="form-field"><span>Cruise speed</span><input type="number" min={120} max={560} step={10} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /><small className="form-help">120 to 560 knots</small></label>
            <label className="form-field is-wide"><span>Demo time scale: {timeScale}x</span><input type="range" min={1} max={120} step={1} value={timeScale} onChange={(event) => setTimeScale(Number(event.target.value))} /><small className="form-help">Aircraft motion remains synchronized to simulated time; wall-clock ETA is shown separately.</small></label>
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
          {readOnly && <div className="form-error" role="status">Route changes are disabled until live telemetry is synchronized.</div>}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="submit" disabled={!canSubmit || busy || readOnly}>{busy ? <Loader2 className="spin" aria-hidden="true" /> : <PlaneTakeoff aria-hidden="true" />}Start synchronized demo</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AirportField({ label, value, icon, active, searching, onFocus, onChange }: { label: string; value: string; icon: React.ReactNode; active: boolean; searching: boolean; onFocus: () => void; onChange: (value: string) => void }) {
  return (
    <label className={`airport-field ${active ? 'is-active' : ''}`}>
      <span className="airport-field__icon" aria-hidden="true">{searching ? <Loader2 className="spin" /> : icon}</span>
      <span><small>{label}</small><input value={value} onFocus={onFocus} onChange={(event) => onChange(event.target.value.toUpperCase())} maxLength={80} autoComplete="off" spellCheck={false} aria-label={`${label} airport code or name`} /></span>
      <Search aria-hidden="true" />
    </label>
  );
}

function CoordinateFields({ prefix, value, onChange }: { prefix: string; value: { lat: string; lon: string }; onChange: (value: { lat: string; lon: string }) => void }) {
  return (
    <fieldset className="coordinate-fieldset"><legend>{prefix}</legend>
      <label className="form-field"><span>Latitude</span><input type="number" min={-90} max={90} step="any" value={value.lat} onChange={(event) => onChange({ ...value, lat: event.target.value })} /></label>
      <label className="form-field"><span>Longitude</span><input type="number" min={-180} max={180} step="any" value={value.lon} onChange={(event) => onChange({ ...value, lon: event.target.value })} /></label>
    </fieldset>
  );
}
