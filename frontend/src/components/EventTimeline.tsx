import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, AlertTriangle, Archive, MapPin, Radio, Route, ShieldAlert } from 'lucide-react';
import type { SimData } from '../hooks/useSimData';
import type { ChatMessage } from './ChatPanel';

interface Props {
  sim: SimData;
  messages: ChatMessage[];
  dataAgeMs?: number | null;
  onSelectTarget?: (callsign: string) => void;
  onOpenArchive?: () => void;
}

type TimelineKind = 'normal' | 'advisory' | 'warning';
type TimelineCategory = 'flight' | 'atc' | 'alert' | 'system';
type TimelineFilter = 'all' | TimelineCategory;
type TimelineIcon = 'activity' | 'alert' | 'map' | 'radio' | 'route' | 'shield';

interface TimelineItem {
  id: string;
  title: string;
  detail: string;
  timestamp: string | null;
  kind: TimelineKind;
  category: TimelineCategory;
  icon: TimelineIcon;
  callsign?: string;
}

function displayTime(value?: string | null): string {
  if (!value) return 'NOW';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.length <= 10 ? value : 'NOW';
  return `${parsed.toISOString().slice(11, 19)}Z`;
}

function iconFor(icon: TimelineIcon): ReactNode {
  if (icon === 'activity') return <Activity aria-hidden="true" />;
  if (icon === 'alert') return <AlertTriangle aria-hidden="true" />;
  if (icon === 'map') return <MapPin aria-hidden="true" />;
  if (icon === 'route') return <Route aria-hidden="true" />;
  if (icon === 'shield') return <ShieldAlert aria-hidden="true" />;
  return <Radio aria-hidden="true" />;
}

function buildTimelineItems(sim: SimData, messages: ChatMessage[], dataAgeMs?: number | null): TimelineItem[] {
  const observedAt = sim.timestamps.server_at || sim.observed_at || sim.timestamps.received_at || null;
  const items: TimelineItem[] = [];
  const freshness = !sim.connected && sim.source === 'unknown' ? 'offline' : (dataAgeMs ?? 0) > 5_000 || sim.quality.stale ? 'stale' : 'live';

  items.push({
    id: `stream:${freshness}`,
    title: freshness === 'live' ? 'State stream synchronized' : freshness === 'stale' ? 'Telemetry stale' : 'State stream unavailable',
    detail: freshness === 'live' ? `Authoritative sequence ${sim.sequence.toLocaleString()}` : freshness === 'stale' ? `Last snapshot ${Math.max(1, Math.round((dataAgeMs || 0) / 1_000))} seconds ago` : 'Waiting for an authoritative backend snapshot',
    timestamp: observedAt,
    kind: freshness === 'live' ? 'normal' : 'warning',
    category: 'system',
    icon: 'radio',
  });

  items.push({
    id: `control:${sim.scenario_control.changed_at}:${sim.scenario_control.paused}:${sim.scenario_control.time_scale}`,
    title: sim.scenario_control.paused ? 'Live simulation paused' : `Live simulation running at ${sim.scenario_control.time_scale}×`,
    detail: `Simulation clock ${Math.floor(sim.scenario_control.simulation_time_seconds / 60)} min · snapshot ${sim.scenario_control.snapshot_sequence}`,
    timestamp: sim.scenario_control.changed_at,
    kind: sim.scenario_control.paused ? 'warning' : 'normal',
    category: 'system',
    icon: 'activity',
  });

  const phase = sim.phase_label || sim.phase || 'Awaiting flight';
  items.push({
    id: `phase:${phase}`,
    title: phase,
    detail: sim.on_ground ? 'Ground state verified' : `${Math.round(sim.altitude).toLocaleString()} ft · ${Math.round(sim.ground_speed)} kt · ${Math.round(sim.vertical_speed_fpm)} fpm`,
    timestamp: observedAt,
    kind: 'advisory',
    category: 'flight',
    icon: 'activity',
  });

  if (sim.route) {
    const progress = Math.max(0, Math.min(100, sim.route.progress_pct ?? sim.route.progress ?? ((sim.route_progress?.completion_ratio || 0) * 100)));
    const milestone = Math.floor(progress / 10) * 10;
    const routeId = sim.route.route_id || `${sim.route.origin_icao || 'ORIGIN'}-${sim.route.destination_icao || 'DESTINATION'}`;
    items.push({
      id: `route:${routeId}:${milestone}:${sim.route.status || 'active'}`,
      title: `${sim.route.origin_icao || sim.route.origin?.icao || 'ORIGIN'} to ${sim.route.destination_icao || sim.route.destination?.icao || 'DESTINATION'}`,
      detail: `${Math.round(progress)}% complete · ${Math.round(sim.route.distance_remaining_nm ?? sim.route.remaining_distance_nm ?? 0)} NM remaining`,
      timestamp: observedAt,
      kind: 'normal',
      category: 'flight',
      icon: 'route',
    });
  }

  for (const conflict of (sim.conflicts || []).slice(0, 5)) {
    items.push({
      id: `conflict:${conflict.conflict_id || conflict.callsign}`,
      title: `Traffic conflict — ${conflict.callsign}`,
      detail: conflict.advisory || `${conflict.range_nm.toFixed(1)} NM · ${Math.round(Math.abs(conflict.alt_diff_ft)).toLocaleString()} ft vertical`,
      timestamp: observedAt,
      kind: 'warning',
      category: 'alert',
      icon: 'alert',
      callsign: conflict.callsign,
    });
  }

  if (sim.active_emergency && sim.active_emergency.status !== 'resolved') {
    const emergency = sim.active_emergency;
    items.push({
      id: `emergency:${emergency.id}:${emergency.status}`,
      title: emergency.title,
      detail: `${emergency.status} · squawk ${emergency.squawk || sim.squawk}`,
      timestamp: emergency.updated_at || emergency.declared_at,
      kind: 'warning',
      category: 'alert',
      icon: 'shield',
    });
  }

  const seenAdvisoryIds = new Set<string>();
  let advisoryCount = 0;
  for (const advisory of [...(sim.alerts || []), ...(sim.advisories || [])]) {
    const advisoryId = advisory.alert_id || advisory.id || `${advisory.type}:${advisory.title}:${advisory.message}`;
    if (seenAdvisoryIds.has(advisoryId)) continue;
    seenAdvisoryIds.add(advisoryId);
    items.push({
      id: `advisory:${advisoryId}`,
      title: advisory.title || 'Operational advisory',
      detail: advisory.message || advisory.summary || advisory.action || 'Review advisory',
      timestamp: advisory.created_at || observedAt,
      kind: advisory.severity === 'info' ? 'advisory' : 'warning',
      category: 'alert',
      icon: advisory.type === 'route' ? 'map' : 'alert',
    });
    advisoryCount += 1;
    if (advisoryCount >= 6) break;
  }

  for (const message of messages.slice(-8)) {
    items.push({
      id: `message:${message.id}`,
      title: message.role === 'atc' ? 'ATC transmission' : message.role === 'pilot' ? 'Pilot transmission' : 'System event',
      detail: message.text,
      timestamp: message.timestamp,
      kind: message.role === 'system' ? 'advisory' : 'normal',
      category: message.role === 'system' ? 'system' : message.role === 'atc' ? 'atc' : 'flight',
      icon: 'radio',
    });
  }

  return items;
}

export default function EventTimeline({ sim, messages, dataAgeMs, onSelectTarget, onOpenArchive }: Props) {
  const candidates = useMemo(() => buildTimelineItems(sim, messages, dataAgeMs), [dataAgeMs, messages, sim]);
  const [history, setHistory] = useState<TimelineItem[]>(() => candidates);
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [followLive, setFollowLive] = useState(true);
  const sessionRef = useRef(sim.session_id);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHistory((current) => {
      if (sessionRef.current !== sim.session_id) {
        sessionRef.current = sim.session_id;
        return candidates;
      }
      const ids = new Set(current.map((item) => item.id));
      const additions = candidates.filter((item) => !ids.has(item.id));
      return additions.length ? [...current, ...additions].slice(-80) : current;
    });
  }, [candidates, sim.session_id]);

  const filtered = history.filter((item) => filter === 'all' || item.category === filter);

  useEffect(() => {
    if (!followLive || !trackRef.current) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    trackRef.current.scrollTo({ left: trackRef.current.scrollWidth, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [filtered.length, followLive]);

  const filters: Array<{ id: TimelineFilter; label: string }> = [
    { id: 'all', label: 'All events' },
    { id: 'flight', label: 'Flight' },
    { id: 'atc', label: 'ATC' },
    { id: 'alert', label: 'Alerts' },
    { id: 'system', label: 'System' },
  ];

  return (
    <section className="event-timeline" aria-label="Flight event timeline">
      <div className="timeline-toolbar">
        <strong className="timeline-title">Event timeline</strong>
        <div className="timeline-filters" aria-label="Filter timeline events">
          {filters.map((item) => <button key={item.id} className={`timeline-filter ${filter === item.id ? 'is-active' : ''}`} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
        </div>
        <div className="timeline-actions">
          {onOpenArchive && <button className="timeline-archive" type="button" onClick={onOpenArchive}><Archive aria-hidden="true" /><span>Session archive</span></button>}
          <button className={`timeline-live ${followLive ? 'is-active' : ''}`} type="button" aria-pressed={followLive} onClick={() => setFollowLive((current) => !current)}><span className="health-dot" />{followLive ? 'Following live' : 'History held'}</button>
        </div>
      </div>
      <div className="timeline-track" ref={trackRef} onScroll={(event) => {
        const target = event.currentTarget;
        if (target.scrollWidth - target.scrollLeft - target.clientWidth > 32 && followLive) setFollowLive(false);
      }}>
        {filtered.map((item) => (
          <article className={`timeline-event is-${item.kind}`} key={item.id}>
            <span className="timeline-event__icon">{iconFor(item.icon)}</span>
            <div>
              <time>{displayTime(item.timestamp)}</time>
              <strong>{item.title}</strong>
              <p title={item.detail}>{item.detail}</p>
              {item.callsign && <button type="button" onClick={() => onSelectTarget?.(item.callsign as string)}>Show target</button>}
            </div>
          </article>
        ))}
        {!filtered.length && <div className="timeline-empty"><Radio aria-hidden="true" /><span>No recorded events match this filter.</span></div>}
      </div>
    </section>
  );
}
