import { useEffect, useRef, useState } from 'react';
import type { OperationalAlert } from '../utils/operationalAlerts';

interface Props {
  alerts: OperationalAlert[];
  scopeId: string;
}

const announcedCriticalAlerts = new Set<string>();

export default function CriticalAlertAnnouncer({ alerts, scopeId }: Props) {
  const announcedIds = useRef(announcedCriticalAlerts);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const critical = alerts.filter((alert) => alert.severity === 'critical' && !announcedIds.current.has(`${scopeId}:${alert.id}`));
    if (!critical.length) return;
    critical.forEach((alert) => announcedIds.current.add(`${scopeId}:${alert.id}`));
    const primary = critical[0];
    const additional = critical.length > 1 ? ` ${critical.length - 1} additional critical alert${critical.length === 2 ? '' : 's'} received.` : '';
    setAnnouncement(`Critical alert. ${primary.title}. ${primary.message}${additional}`);
  }, [alerts, scopeId]);

  return <div className="sr-only" aria-live="assertive" aria-atomic="true">{announcement}</div>;
}
