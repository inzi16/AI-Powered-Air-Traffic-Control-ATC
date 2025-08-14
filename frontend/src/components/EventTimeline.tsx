import { Activity, AlertTriangle, MapPin, Radio, Route, ShieldAlert } from 'lucide-react';
import type { SimData } from '../hooks/useSimData';
import type { ChatMessage } from './ChatPanel';

interface Props {
  sim: SimData;
  messages: ChatMessage[];
  dataAgeMs?: number | null;
}

type TimelineKind = 'normal' | 'advisory' | 'warning';

interface TimelineItem {
  id: string;
  title: string;
  detail: string;
  time: string;
  kind: TimelineKind;
  icon: React.ReactNode;
}

function displayTime(value?: string | null): string {
  if (!value) return 'NOW';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'NOW';
  return `${parsed.toISOString().slice(11, 19)}Z`;
}

export default function EventTimeline({ sim, messages, dataAgeMs }: Props) {
  const route = sim.route;
  const emergency = sim.active_emergency;
  const conflict = sim.conflicts[0];
  const lastMessage = messages.at(-1);
  const items: TimelineItem[] = [
    emergency
      ? {
          id: `emergency-${emergency.id}`,
          title: emergency.title,
          detail: `${emergency.status} - squawk ${emergency.squawk || sim.squawk}`,
          time: displayTime(emergency.declared_at),
          kind: 'warning',
          icon: <ShieldAlert aria-hidden="true" />,
        }
      : {
          id: 'phase',
          title: sim.phase_label || sim.phase || 'Awaiting flight',
          detail: sim.on_ground ? 'Ground state verified' : `${Math.round(sim.altitude).toLocaleString()} ft at ${Math.round(sim.ground_speed)} kt`,
          time: displayTime(sim.observed_at),
          kind: 'advisory',
          icon: <Activity aria-hidden="true" />,
        },
    route
      ? {
          id: 'route',
          title: `${route.origin_icao || 'ORIGIN'} to ${route.destination_icao || 'DESTINATION'}`,
          detail: `${Math.round(route.progress_pct || 0)}% complete - ${Math.round(route.distance_remaining_nm || 0)} NM remaining`,
          time: 'ROUTE',
          kind: 'normal',
          icon: <Route aria-hidden="true" />,
        }
      : {
          id: 'route-empty',
          title: 'No active route',
          detail: 'Plan a global demo flight from the top bar',
          time: 'PLAN',
          kind: 'normal',
          icon: <MapPin aria-hidden="true" />,
        },
    conflict
      ? {
          id: `conflict-${conflict.callsign}`,
          title: `Traffic ${conflict.callsign}`,
          detail: `${conflict.range_nm.toFixed(1)} NM, ${Math.round(Math.abs(conflict.alt_diff_ft))} ft vertical`,
          time: 'CPA',
          kind: 'warning',
          icon: <AlertTriangle aria-hidden="true" />,
        }
      : {
          id: 'separation',
          title: 'Separation monitor clear',
          detail: 'No predicted loss of separation',
          time: 'LIVE',
          kind: 'normal',
          icon: <Radio aria-hidden="true" />,
        },
    lastMessage
      ? {
          id: `message-${lastMessage.id}`,
          title: lastMessage.role === 'atc' ? 'ATC transmission' : lastMessage.role === 'pilot' ? 'Pilot transmission' : 'System event',
          detail: lastMessage.text,
          time: lastMessage.timestamp,
          kind: lastMessage.role === 'system' ? 'warning' : 'normal',
          icon: <Radio aria-hidden="true" />,
        }
      : {
          id: 'stream',
          title: 'State stream ready',
          detail: dataAgeMs == null ? 'Waiting for authoritative telemetry' : `Last snapshot ${Math.round(dataAgeMs)} ms ago`,
          time: 'SYNC',
          kind: dataAgeMs != null && dataAgeMs > 5_000 ? 'warning' : 'normal',
          icon: <Radio aria-hidden="true" />,
        },
  ];

  return (
    <section className="event-timeline" aria-label="Flight event timeline">
      <div className="timeline-toolbar">
        <strong className="timeline-title">Event timeline</strong>
        <span className="timeline-filter is-active">All events</span>
        <span className="timeline-filter">Flight</span>
        <span className="timeline-filter">ATC</span>
        <span className="timeline-filter">System</span>
        <span className="timeline-live"><span className="health-dot" />Live synchronized</span>
      </div>
      <div className="timeline-track">
        {items.map((item) => (
          <article className={`timeline-event is-${item.kind}`} key={item.id}>
            <span className="timeline-event__icon">{item.icon}</span>
            <div>
              <time>{item.time}</time>
              <strong>{item.title}</strong>
              <p title={item.detail}>{item.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
