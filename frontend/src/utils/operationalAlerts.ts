import type { Advisory, SimData } from '../types/sim';

export type OperationalAlertSeverity = 'critical' | 'warning' | 'caution' | 'info';
export type OperationalAlertCategory = 'emergency' | 'traffic' | 'weather' | 'flight' | 'system';

export interface OperationalAlert {
  id: string;
  title: string;
  message: string;
  severity: OperationalAlertSeverity;
  category: OperationalAlertCategory;
  createdAt: string | null;
  acknowledged: boolean;
  requiresAcknowledgement: boolean;
  acknowledgementScope: 'authoritative' | 'local';
  authoritativeId?: string;
  callsign?: string;
}

interface BuildAlertOptions {
  backendOnline: boolean;
  dataAgeMs?: number | null;
}

const severityRank: Record<OperationalAlertSeverity, number> = { critical: 4, warning: 3, caution: 2, info: 1 };

function normalizeSeverity(value?: string): OperationalAlertSeverity {
  const severity = value?.toLowerCase();
  if (severity === 'critical' || severity === 'resolution' || severity === 'distress' || severity === 'catastrophic') return 'critical';
  if (severity === 'warning' || severity === 'traffic' || severity === 'urgent') return 'warning';
  if (severity === 'caution' || severity === 'advisory') return 'caution';
  return 'info';
}

function advisoryCategory(advisory: Advisory): OperationalAlertCategory {
  const category = `${advisory.category || ''} ${advisory.type || ''}`.toLowerCase();
  if (category.includes('traffic') || category.includes('airspace')) return 'traffic';
  if (category.includes('emergency')) return 'emergency';
  if (category.includes('weather')) return 'weather';
  if (category.includes('system')) return 'system';
  return 'flight';
}

export function buildOperationalAlerts(sim: SimData, options: BuildAlertOptions): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const timestamp = sim.timestamps.server_at || sim.observed_at || sim.timestamps.received_at || null;
  const authoritativeAdvisories = [...(sim.alerts || []), ...(sim.advisories || [])];
  const authoritativeIds = new Set(authoritativeAdvisories.map((advisory) => advisory.alert_id || advisory.id).filter(Boolean));

  if (!options.backendOnline) {
    alerts.push({ id: 'system:backend-offline', title: 'Backend connection lost', message: 'Live state is unavailable. Reconnect before making training decisions from this display.', severity: 'critical', category: 'system', createdAt: timestamp, acknowledged: false, requiresAcknowledgement: true, acknowledgementScope: 'local' });
  } else if ((options.dataAgeMs ?? 0) > 5_000 || sim.quality.stale) {
    alerts.push({ id: 'system:telemetry-stale', title: 'Telemetry is stale', message: `The latest authoritative snapshot is ${Math.max(1, Math.round((options.dataAgeMs || sim.quality.age_ms || 0) / 1_000))} seconds old.`, severity: 'warning', category: 'system', createdAt: timestamp, acknowledged: false, requiresAcknowledgement: true, acknowledgementScope: 'local' });
  }

  const emergency = sim.active_emergency;
  if (emergency && emergency.status !== 'resolved' && !authoritativeIds.has(`emergency:${emergency.id}`)) {
    alerts.push({
      id: `emergency:${emergency.id}:${emergency.status}`,
      title: emergency.title || 'Active emergency',
      message: emergency.alert_message || emergency.description || `Emergency workflow is ${emergency.status}.`,
      severity: normalizeSeverity(emergency.severity),
      category: 'emergency',
      createdAt: emergency.updated_at || emergency.declared_at,
      acknowledged: false,
      requiresAcknowledgement: true,
      acknowledgementScope: 'local',
    });
  }

  for (const conflict of sim.conflicts || []) {
    if (authoritativeIds.has(conflict.conflict_id || conflict.callsign)) continue;
    alerts.push({
      id: `conflict:${conflict.conflict_id || conflict.callsign}`,
      title: `Traffic conflict — ${conflict.callsign}`,
      message: conflict.advisory || `${conflict.range_nm.toFixed(1)} NM range with ${Math.round(Math.abs(conflict.alt_diff_ft)).toLocaleString()} ft vertical separation.`,
      severity: normalizeSeverity(conflict.severity),
      category: 'traffic',
      createdAt: timestamp,
      acknowledged: false,
      requiresAcknowledgement: true,
      acknowledgementScope: 'local',
      callsign: conflict.callsign,
    });
  }

  const knownAdvisories = new Set<string>();
  for (const advisory of authoritativeAdvisories) {
    const sourceId = advisory.alert_id || advisory.id;
    if (!sourceId || knownAdvisories.has(sourceId)) continue;
    knownAdvisories.add(sourceId);
    alerts.push({
      id: `authoritative:${sourceId}`,
      title: advisory.title || 'Operational advisory',
      message: advisory.message || advisory.summary || advisory.action || 'Review the latest operational advisory.',
      severity: normalizeSeverity(advisory.severity),
      category: advisoryCategory(advisory),
      createdAt: advisory.created_at || timestamp,
      acknowledged: Boolean(advisory.acknowledged),
      requiresAcknowledgement: advisory.requires_acknowledgement !== false,
      acknowledgementScope: 'authoritative',
      authoritativeId: sourceId,
      ...(sim.conflicts.find((conflict) => conflict.conflict_id === sourceId)?.callsign
        ? { callsign: sim.conflicts.find((conflict) => conflict.conflict_id === sourceId)?.callsign }
        : {}),
    });
  }

  for (const issue of sim.quality.issues || []) {
    alerts.push({
      id: `quality:${issue.code}:${issue.field || 'state'}`,
      title: 'State quality issue',
      message: issue.message,
      severity: normalizeSeverity(issue.severity),
      category: 'system',
      createdAt: timestamp,
      acknowledged: false,
      requiresAcknowledgement: true,
      acknowledgementScope: 'local',
    });
  }

  return alerts.sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
}
