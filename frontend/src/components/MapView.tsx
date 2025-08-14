import { useEffect, useMemo, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Circle, MapContainer, Marker, Polyline, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Crosshair, Navigation, Plane } from 'lucide-react';
import type { SimData, TrafficContact } from '../hooks/useSimData';

type Waypoint = { lat: number; lon: number; ident?: string };
type EnrichedSimData = SimData & {
  session_id?: string;
  sequence?: number;
  route?: { waypoints?: Waypoint[]; origin_icao?: string; destination_icao?: string } | null;
  observed_at?: string;
  data_age_ms?: number;
};

interface Props { sim: EnrichedSimData }

const DEFAULT_CENTER: [number, number] = [12.9941, 80.1709];
const MAX_TRAIL_POINTS = 240;

function iconHtml(color: string, heading: number, size: number, strokeWidth = 1.8): string {
  return renderToStaticMarkup(
    <Plane
      width={size}
      height={size}
      color={color}
      fill={color}
      strokeWidth={strokeWidth}
      style={{ transform: `rotate(${heading - 45}deg)`, filter: `drop-shadow(0 0 5px ${color}66)` }}
      aria-hidden="true"
    />,
  );
}

function aircraftIcon(heading: number, color: string, ownship = false): L.DivIcon {
  const size = ownship ? 34 : 22;
  return L.divIcon({
    html: iconHtml(color, heading, size, ownship ? 2 : 1.6),
    className: 'aircraft-marker',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function airportIcon(color: string): L.DivIcon {
  const html = renderToStaticMarkup(<Crosshair width={24} height={24} color={color} strokeWidth={2} aria-hidden="true" />);
  return L.divIcon({ html, className: 'aircraft-marker', iconSize: [24, 24], iconAnchor: [12, 12] });
}

function destinationPoint(lat: number, lon: number, bearing: number, distanceNm: number): [number, number] {
  const radiusNm = 3440.065;
  const angularDistance = distanceNm / radiusNm;
  const bearingRad = bearing * Math.PI / 180;
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const nextLat = Math.asin(Math.sin(latRad) * Math.cos(angularDistance) + Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearingRad));
  const nextLon = lonRad + Math.atan2(Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(latRad), Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(nextLat));
  return [nextLat * 180 / Math.PI, nextLon * 180 / Math.PI];
}

function distanceNm(a: [number, number], b: [number, number]): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const dLat = toRadians(b[0] - a[0]);
  const dLon = toRadians(b[1] - a[1]);
  const lat1 = toRadians(a[0]);
  const lat2 = toRadians(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function altitudeZoom(altitude: number, onGround: boolean): number {
  if (onGround) return 13;
  if (altitude < 5_000) return 11;
  if (altitude < 15_000) return 8;
  if (altitude < 30_000) return 7;
  return 6;
}

function MapController({ center, zoom, follow, onFreePan }: { center: [number, number]; zoom: number; follow: boolean; onFreePan: () => void }) {
  const map = useMap();
  const previous = useRef(center);

  useMapEvents({ dragstart: onFreePan, zoomstart: onFreePan });

  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    resizeObserver.observe(map.getContainer());
    return () => resizeObserver.disconnect();
  }, [map]);

  useEffect(() => {
    if (!follow) return;
    const jump = distanceNm(previous.current, center);
    if (jump > 40) map.flyTo(center, zoom, { duration: 1.1 });
    else map.panTo(center, { animate: false });
    previous.current = center;
  }, [center, follow, map, zoom]);

  return null;
}

export default function MapView({ sim }: Props) {
  const [follow, setFollow] = useState(true);
  const [trail, setTrail] = useState<[number, number][]>([]);
  const trailSession = useRef(sim.session_id);
  const validPosition = sim.sequence > 0 && sim.timestamps.received_at_ms > 0 && Number.isFinite(sim.lat) && Number.isFinite(sim.lon) && Math.abs(sim.lat) <= 90 && Math.abs(sim.lon) <= 180;
  const originLat = sim.route_plan?.origin?.lat;
  const originLon = sim.route_plan?.origin?.lon;
  const center = useMemo<[number, number]>(() => {
    if (validPosition) return [sim.lat, sim.lon];
    if (originLat != null && originLon != null) return [originLat, originLon];
    return DEFAULT_CENTER;
  }, [originLat, originLon, sim.lat, sim.lon, validPosition]);
  const emergency = Boolean(sim.emergency_active) || ['7500', '7600', '7700'].includes(sim.squawk);
  const conflictIds = useMemo(() => new Set((sim.conflicts || []).map((item) => item.callsign)), [sim.conflicts]);
  const zoom = altitudeZoom(sim.altitude || 0, sim.on_ground);
  const ownshipColor = emergency ? '#ff8a75' : '#c9ff18';

  useEffect(() => {
    if (!validPosition) return;
    const frame = window.requestAnimationFrame(() => {
      setTrail((current) => {
        if (trailSession.current !== sim.session_id) {
          trailSession.current = sim.session_id;
          return [center];
        }
        const last = current[current.length - 1];
        if (!last) return [center];
        const movement = distanceNm(last, center);
        if (movement > 80) return [center];
        if (movement < 0.015) return current;
        return [...current.slice(-(MAX_TRAIL_POINTS - 1)), center];
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [center, sim.session_id, validPosition]);

  const headingEnd = useMemo(() => destinationPoint(center[0], center[1], sim.heading_mag || 0, Math.max(4, Math.min(20, (sim.ground_speed || 0) / 25))), [center, sim.ground_speed, sim.heading_mag]);
  const routePoints = useMemo<[number, number][]>(() => {
    const points = (sim.route?.waypoints || []).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon)).map((item) => [item.lat, item.lon] as [number, number]);
    if (points.length > 1) return points;
    if (sim.nearest_airport) return [center, [sim.nearest_airport.lat, sim.nearest_airport.lon]];
    return [];
  }, [center, sim.nearest_airport, sim.route?.waypoints]);

  const traffic = useMemo(() => [...(sim.traffic || [])]
    .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon))
    .sort((a, b) => Number(conflictIds.has(b.callsign)) - Number(conflictIds.has(a.callsign)) || a.range_nm - b.range_nm)
    .slice(0, 45), [conflictIds, sim.traffic]);

  return (
    <div className="map-shell" aria-label="Live geographic flight map">
      <MapContainer center={center} zoom={zoom} zoomControl={false} attributionControl>
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          subdomains={['a', 'b', 'c', 'd']}
          attribution='&copy; OpenStreetMap contributors &copy; CARTO'
        />
        <MapController center={center} zoom={zoom} follow={follow} onFreePan={() => setFollow(false)} />

        {routePoints.length > 1 && <Polyline positions={routePoints} pathOptions={{ color: '#c9ff18', weight: 2.4, opacity: .9 }} />}
        {trail.length > 1 && <Polyline positions={trail} pathOptions={{ color: ownshipColor, weight: 1.5, opacity: .42, dashArray: '3 6' }} />}
        {validPosition && <Polyline positions={[center, headingEnd]} pathOptions={{ color: ownshipColor, weight: 1.2, opacity: .85, dashArray: '7 7' }} />}

        {traffic.map((item: TrafficContact) => {
          const isConflict = conflictIds.has(item.callsign);
          const color = isConflict ? '#f2a154' : '#d1d5c9';
          return (
            <Marker key={item.callsign} position={[item.lat, item.lon]} icon={aircraftIcon(item.heading, color)}>
              <Popup>
                <div className="mono">
                  <strong style={{ color }}>{item.callsign}</strong><br />
                  {item.type} · {Math.round(item.altitude).toLocaleString()} ft<br />
                  {Math.round(item.speed)} kt · {String(Math.round(item.heading)).padStart(3, '0')}°<br />
                  {item.range_nm.toFixed(1)} NM · SQK {item.squawk}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {validPosition && (
          <Marker position={center} icon={aircraftIcon(sim.heading_mag || 0, ownshipColor, true)} zIndexOffset={1000}>
            <Popup>
              <div className="mono">
                <strong style={{ color: ownshipColor }}>{sim.callsign || 'OWNSHIP'}</strong><br />
                {Math.round(sim.altitude).toLocaleString()} ft · {Math.round(sim.ground_speed)} kt<br />
                HDG {String(Math.round(sim.heading_mag)).padStart(3, '0')}° · SQK {sim.squawk}
              </div>
            </Popup>
          </Marker>
        )}

        {sim.nearest_airport && (
          <>
            <Marker position={[sim.nearest_airport.lat, sim.nearest_airport.lon]} icon={airportIcon('#c9ff18')}>
              <Popup><div className="mono"><strong>{sim.nearest_airport.icao}</strong><br />{sim.nearest_airport.name}<br />RWY {sim.nearest_airport.rwys?.join(' · ')}</div></Popup>
            </Marker>
            <Circle center={[sim.nearest_airport.lat, sim.nearest_airport.lon]} radius={9_260} pathOptions={{ color: '#c9ff18', fillOpacity: .02, weight: 1, dashArray: '5 6' }} />
          </>
        )}
      </MapContainer>

      <div className="map-hud map-hud--top">
        <button className={`icon-button ${follow ? 'is-active' : ''}`} type="button" onClick={() => setFollow(true)} aria-label="Follow ownship" title="Follow ownship"><Navigation aria-hidden="true" /></button>
      </div>
      <div className="map-hud map-hud--bottom">
        <div className="map-readout">
          <strong>{sim.callsign || 'OWNSHIP'}</strong><br />
          {center[0].toFixed(4)}, {center[1].toFixed(4)}<br />
          DATA AGE {sim.data_age_ms != null ? `${Math.round(sim.data_age_ms)} ms` : '—'}
        </div>
        {sim.weather && <div className="map-readout">WND {String(sim.weather.wind_dir).padStart(3, '0')}°/{sim.weather.wind_kts} kt<br />QNH {sim.weather.qnh_hpa}<br />VIS {sim.weather.visibility_km} km</div>}
      </div>
    </div>
  );
}
