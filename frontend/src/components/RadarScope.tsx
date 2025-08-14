import { useMemo, useState } from 'react';
import type { ConflictAlert, SimData, TrafficContact } from '../hooks/useSimData';

type EnrichedConflict = ConflictAlert & {
  cpa_distance_nm?: number;
  cpa_vertical_ft?: number;
  time_to_cpa_s?: number;
  severity?: string;
};

type EnrichedSimData = SimData & {
  data_age_ms?: number;
  sequence?: number;
};

interface Props { sim: EnrichedSimData }

const RANGE_OPTIONS = [10, 25, 50, 100];
const SCOPE_RADIUS = 41;

interface PositionedTrack {
  traffic: TrafficContact;
  x: number;
  y: number;
  vectorX: number;
  vectorY: number;
  conflict?: EnrichedConflict;
  altitudeDelta: number;
}

function polarPoint(rangeNm: number, bearing: number, maxRange: number, heading: number, headUp: boolean): [number, number] {
  const relativeBearing = headUp ? (bearing - heading + 360) % 360 : bearing;
  const angle = (relativeBearing - 90) * Math.PI / 180;
  const radius = (rangeNm / maxRange) * SCOPE_RADIUS;
  return [50 + Math.cos(angle) * radius, 50 + Math.sin(angle) * radius];
}

function vectorEnd(x: number, y: number, trackHeading: number, ownHeading: number, headUp: boolean, length = 5): [number, number] {
  const relativeHeading = headUp ? (trackHeading - ownHeading + 360) % 360 : trackHeading;
  const angle = (relativeHeading - 90) * Math.PI / 180;
  return [x + Math.cos(angle) * length, y + Math.sin(angle) * length];
}

export default function RadarScope({ sim }: Props) {
  const [rangeNm, setRangeNm] = useState(25);
  const [headUp, setHeadUp] = useState(true);
  const [showVectors, setShowVectors] = useState(true);
  const [selectedCallsign, setSelectedCallsign] = useState<string | null>(null);
  const heading = sim.heading_mag || 0;
  const altitude = sim.altitude || 0;
  const conflictByCallsign = useMemo(() => new Map((sim.conflicts || []).map((item) => [item.callsign, item as EnrichedConflict])), [sim.conflicts]);

  const tracks = useMemo<PositionedTrack[]>(() => (sim.traffic || [])
    .filter((item) => Number.isFinite(item.range_nm) && item.range_nm <= rangeNm)
    .sort((a, b) => Number(conflictByCallsign.has(b.callsign)) - Number(conflictByCallsign.has(a.callsign)) || a.range_nm - b.range_nm)
    .slice(0, 40)
    .map((traffic) => {
      const [x, y] = polarPoint(traffic.range_nm, traffic.bearing, rangeNm, heading, headUp);
      const [vectorX, vectorY] = vectorEnd(x, y, traffic.heading, heading, headUp, 4 + Math.min(4, traffic.speed / 120));
      return { traffic, x, y, vectorX, vectorY, conflict: conflictByCallsign.get(traffic.callsign), altitudeDelta: traffic.altitude - altitude };
    }), [altitude, conflictByCallsign, headUp, heading, rangeNm, sim.traffic]);

  const primaryConflict = (sim.conflicts?.[0] || null) as EnrichedConflict | null;
  const ownshipVector = vectorEnd(50, 50, heading, heading, headUp, 8);
  const selected = tracks.find((track) => track.traffic.callsign === (selectedCallsign || primaryConflict?.callsign)) || tracks[0];
  const cpaGeometry = useMemo(() => {
    const conflictTrack = tracks.find((track) => track.traffic.callsign === primaryConflict?.callsign);
    if (!primaryConflict || !conflictTrack) return null;
    const seconds = primaryConflict.time_to_cpa_s ?? primaryConflict.time_to_cpa_seconds ?? 120;
    const ownLength = Math.min(25, Math.max(7, ((sim.ground_speed || 180) * seconds / 3600 / rangeNm) * SCOPE_RADIUS));
    const intruderLength = Math.min(25, Math.max(7, (conflictTrack.traffic.speed * seconds / 3600 / rangeNm) * SCOPE_RADIUS));
    const ownEnd = vectorEnd(50, 50, heading, heading, headUp, ownLength);
    const trafficEnd = vectorEnd(conflictTrack.x, conflictTrack.y, conflictTrack.traffic.heading, heading, headUp, intruderLength);
    return { conflictTrack, ownEnd, trafficEnd, cpa: [(ownEnd[0] + trafficEnd[0]) / 2, (ownEnd[1] + trafficEnd[1]) / 2] as [number, number] };
  }, [headUp, heading, primaryConflict, rangeNm, sim.ground_speed, tracks]);

  return (
    <div className="radar-shell" aria-label={`Surveillance radar, ${rangeNm} nautical mile range`}>
      <svg viewBox="0 0 100 100" role="img" aria-labelledby="radar-title radar-description" preserveAspectRatio="xMidYMid meet">
        <title id="radar-title">SkyCommand traffic radar</title>
        <desc id="radar-description">Ownship centered with nearby traffic positioned by range and bearing. Conflicts use orange and red.</desc>
        <rect x="0" y="0" width="100" height="100" fill="#0d0e0c" />

        {[.25, .5, .75, 1].map((fraction) => (
          <g key={fraction}>
            <circle cx="50" cy="50" r={SCOPE_RADIUS * fraction} fill="none" stroke="#30322c" strokeWidth=".22" strokeDasharray="1.3 1.8" />
            <text x="50.8" y={50 - SCOPE_RADIUS * fraction + 1.7} fill="#7a7d74" fontFamily="JetBrains Mono" fontSize="1.25">{Math.round(rangeNm * fraction)}</text>
          </g>
        ))}
        <line x1="9" y1="50" x2="91" y2="50" stroke="#30322c" strokeWidth=".18" />
        <line x1="50" y1="9" x2="50" y2="91" stroke="#30322c" strokeWidth=".18" />
        <text x="50" y="7" textAnchor="middle" fill="#c9ff18" fontFamily="JetBrains Mono" fontSize="1.65">{headUp ? 'HDG' : 'N'}</text>
        <text x="50" y="95" textAnchor="middle" fill="#8b8e84" fontFamily="JetBrains Mono" fontSize="1.35">{headUp ? `${String(Math.round(heading)).padStart(3, '0')}°` : 'S'}</text>
        <text x="5.5" y="50.6" textAnchor="middle" fill="#8b8e84" fontFamily="JetBrains Mono" fontSize="1.35">W</text>
        <text x="94.5" y="50.6" textAnchor="middle" fill="#8b8e84" fontFamily="JetBrains Mono" fontSize="1.35">E</text>

        {cpaGeometry && showVectors && (
          <g className="radar-cpa-geometry">
            <line x1="50" y1="50" x2={cpaGeometry.cpa[0]} y2={cpaGeometry.cpa[1]} stroke="#ff8a75" strokeWidth=".3" strokeDasharray="1.2 1.1" />
            <line x1={cpaGeometry.conflictTrack.x} y1={cpaGeometry.conflictTrack.y} x2={cpaGeometry.cpa[0]} y2={cpaGeometry.cpa[1]} stroke="#f2a154" strokeWidth=".3" strokeDasharray="1.2 1.1" />
            <circle className="radar-conflict-pulse" cx={cpaGeometry.cpa[0]} cy={cpaGeometry.cpa[1]} r="1.7" fill="none" stroke="#ff8a75" strokeWidth=".28" />
            <text x={cpaGeometry.cpa[0] + 1.8} y={cpaGeometry.cpa[1] - 1.2} fill="#ff8a75" fontFamily="JetBrains Mono" fontSize="1.1">CPA</text>
          </g>
        )}

        {tracks.map(({ traffic, x, y, vectorX, vectorY, conflict, altitudeDelta }) => {
          const color = conflict?.severity === 'critical' || conflict?.severity === 'resolution' ? '#ff8a75' : conflict ? '#f2a154' : Math.abs(altitudeDelta) < 1_000 ? '#f1ecd5' : '#abada5';
          return (
            <g key={traffic.callsign} role="button" tabIndex={0} aria-label={`Select ${traffic.callsign}`} onClick={() => setSelectedCallsign(traffic.callsign)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedCallsign(traffic.callsign); }}>
              {showVectors && <line x1={x} y1={y} x2={vectorX} y2={vectorY} stroke={color} strokeWidth={conflict ? '.38' : '.22'} />}
              {showVectors && <line x1={x} y1={y} x2={x - (vectorX - x) * .6} y2={y - (vectorY - y) * .6} stroke="#7a7d74" strokeWidth=".16" strokeDasharray=".7 .7" opacity=".75" />}
              <rect x={x - .65} y={y - .65} width="1.3" height="1.3" transform={`rotate(45 ${x} ${y})`} fill={conflict ? '#0d0e0c' : color} stroke={color} strokeWidth=".32" />
              {(selectedCallsign || primaryConflict?.callsign) === traffic.callsign && <circle cx={x} cy={y} r="2.8" fill="none" stroke="#c9ff18" strokeWidth=".2" strokeDasharray=".8 .7" />}
              {conflict && <circle className="radar-conflict-pulse" cx={x} cy={y} r="2.1" fill="none" stroke="#ff8a75" strokeWidth=".25" />}
              <g transform={`translate(${x + 1.5} ${y - 2.2})`}>
                <rect width="10.8" height="6.2" rx=".35" fill="#11120f" stroke={conflict ? '#f2a154' : '#4a4d44'} strokeWidth=".18" />
                <text x=".7" y="1.8" fill={color} fontFamily="JetBrains Mono" fontSize="1.28" fontWeight="700">{traffic.callsign}</text>
                <text x=".7" y="3.45" fill="#abada5" fontFamily="JetBrains Mono" fontSize="1.05">{traffic.type} · FL{Math.round(traffic.altitude / 100)}</text>
                <text x=".7" y="5.1" fill={color} fontFamily="JetBrains Mono" fontSize="1.05">{Math.round(traffic.speed)} KT · {String(Math.round(traffic.heading)).padStart(3, '0')}°</text>
              </g>
            </g>
          );
        })}

        <line x1="50" y1="50" x2={ownshipVector[0]} y2={ownshipVector[1]} stroke="#c9ff18" strokeWidth=".36" strokeDasharray="1 1" />
        <path d="M 50 48.6 L 48.8 51.2 L 50 50.7 L 51.2 51.2 Z" fill="#c9ff18" />
        <circle cx="50" cy="50" r="2.7" fill="none" stroke="#c9ff18" strokeWidth=".16" opacity=".3" />

        {primaryConflict && (
          <g transform="translate(41 52.5)">
            <rect width="18" height="8.5" rx=".4" fill="#11120f" stroke="#ff8a75" strokeWidth=".2" />
            <text x="9" y="2.5" textAnchor="middle" fill="#ff8a75" fontFamily="JetBrains Mono" fontSize="1.3" fontWeight="700">CONFLICT PREDICTED</text>
            <text x="9" y="4.7" textAnchor="middle" fill="#f6f6ef" fontFamily="JetBrains Mono" fontSize="1.05">
              CPA {(primaryConflict.cpa_distance_nm ?? primaryConflict.range_nm).toFixed(1)} NM / {Math.round(primaryConflict.cpa_vertical_ft ?? primaryConflict.alt_diff_ft)} FT
            </text>
            <text x="9" y="6.8" textAnchor="middle" fill="#abada5" fontFamily="JetBrains Mono" fontSize="1.05">
              {primaryConflict.time_to_cpa_s != null ? `${Math.floor(primaryConflict.time_to_cpa_s / 60).toString().padStart(2, '0')}:${Math.round(primaryConflict.time_to_cpa_s % 60).toString().padStart(2, '0')}` : 'MONITOR'}
            </text>
          </g>
        )}

        <g transform="translate(5 90)">
          <rect width="18" height="5.2" rx=".35" fill="#11120f" stroke="#30322c" strokeWidth=".18" />
          <text x="1" y="2" fill="#abada5" fontFamily="JetBrains Mono" fontSize="1.05">{rangeNm} NM</text>
          <line x1="7" y1="3.4" x2="16.5" y2="3.4" stroke="#f6f6ef" strokeWidth=".22" />
          <line x1="7" y1="2.8" x2="7" y2="4" stroke="#f6f6ef" strokeWidth=".22" />
          <line x1="16.5" y1="2.8" x2="16.5" y2="4" stroke="#f6f6ef" strokeWidth=".22" />
        </g>
      </svg>

      <div className="radar-controls" aria-label="Radar controls">
        {RANGE_OPTIONS.map((value) => (
          <button key={value} className={value === rangeNm ? 'is-active' : ''} type="button" onClick={() => setRangeNm(value)} aria-pressed={value === rangeNm}>{value} NM</button>
        ))}
        <button className="is-active" type="button" onClick={() => setHeadUp((current) => !current)}>{headUp ? 'HEAD UP' : 'NORTH UP'}</button>
        <button className={showVectors ? 'is-active' : ''} type="button" onClick={() => setShowVectors((current) => !current)} aria-pressed={showVectors}>VECTORS</button>
      </div>

      <div className="radar-legend" aria-label="Radar legend"><span><i className="is-actual" />Actual</span><span><i className="is-predicted" />Predicted</span><span><i className="is-history" />History</span></div>

      {selected && (
        <aside className={`radar-detail ${selected.conflict ? 'is-conflict' : ''}`} aria-live="polite">
          <span className="eyebrow">{selected.conflict ? 'Predicted conflict' : 'Selected track'}</span>
          <strong>{selected.traffic.callsign}</strong>
          <dl>
            <div><dt>Range</dt><dd>{selected.traffic.range_nm.toFixed(1)} NM</dd></div>
            <div><dt>Altitude</dt><dd>{Math.round(selected.traffic.altitude).toLocaleString()} ft</dd></div>
            <div><dt>Track</dt><dd>{String(Math.round(selected.traffic.heading)).padStart(3, '0')} deg</dd></div>
            <div><dt>Speed</dt><dd>{Math.round(selected.traffic.speed)} kt</dd></div>
          </dl>
          {selected.conflict && <p>{selected.conflict.advisory || `CPA ${(selected.conflict.cpa_distance_nm ?? selected.conflict.range_nm).toFixed(1)} NM. Maintain active separation monitoring.`}</p>}
        </aside>
      )}

      <table className="sr-only">
        <caption>Traffic contacts in the selected radar range</caption>
        <thead><tr><th>Callsign</th><th>Range</th><th>Bearing</th><th>Altitude</th><th>Speed</th><th>Status</th></tr></thead>
        <tbody>{tracks.map(({ traffic, conflict }) => <tr key={traffic.callsign}><td>{traffic.callsign}</td><td>{traffic.range_nm.toFixed(1)} NM</td><td>{Math.round(traffic.bearing)} degrees</td><td>{Math.round(traffic.altitude)} feet</td><td>{Math.round(traffic.speed)} knots</td><td>{conflict ? 'Conflict predicted' : 'Observed'}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
