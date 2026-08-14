import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Check,
  Clipboard,
  Clock3,
  Copy,
  DoorOpen,
  Gauge,
  LoaderCircle,
  Plus,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  ApiError,
  createTrainingSession,
  deleteTrainingSession,
  fetchTrainingSession,
  listTrainingSessions,
  touchTrainingSession,
  type TrainingSessionMetadata,
  type TrainingSessionQuotaState,
} from '../api';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { isValidTrainingSessionId } from '../state/trainingSession';

interface Props {
  open: boolean;
  activeSessionId: string;
  onSwitch: (session: TrainingSessionMetadata) => void;
  onClose: () => void;
}

function formatDate(value: string | null): string {
  if (!value) return 'Never expires';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatIdle(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3_600).toFixed(seconds % 3_600 === 0 ? 0 : 1)} hr`;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

export default function TrainingSessionLobby({ open, activeSessionId, onSwitch, onClose }: Props) {
  const [sessions, setSessions] = useState<TrainingSessionMetadata[]>([]);
  const [quota, setQuota] = useState<TrainingSessionQuotaState | null>(null);
  const [name, setName] = useState('');
  const [idleTimeout, setIdleTimeout] = useState('');
  const [joinId, setJoinId] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  const switchOperationRef = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const titleId = useId();
  openRef.current = open;
  const cancelSwitchOperation = useCallback(() => {
    switchOperationRef.current.controller?.abort();
    switchOperationRef.current = { generation: switchOperationRef.current.generation + 1, controller: null };
  }, []);
  const closeLobby = useCallback(() => {
    cancelSwitchOperation();
    onClose();
  }, [cancelSwitchOperation, onClose]);
  useDialogFocus(open, closeLobby, dialogRef);

  const activeRoom = useMemo(() => sessions.find((session) => session.session_id === activeSessionId) || null, [activeSessionId, sessions]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await listTrainingSessions({ signal });
      setSessions(response.sessions);
      setQuota(response.quota);
      setIdleTimeout((current) => current || String(response.quota.default_idle_timeout_seconds));
    } catch (requestError) {
      if (!signal?.aborted) setError(requestError instanceof Error ? requestError.message : 'Unable to load training rooms.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [open, refresh]);

  useEffect(() => {
    if (open) return;
    cancelSwitchOperation();
    setCreating(false);
    setWorkingId(null);
  }, [cancelSwitchOperation, open]);

  useEffect(() => () => {
    cancelSwitchOperation();
  }, [cancelSwitchOperation]);

  if (!open) return null;

  const createRoom = async () => {
    const normalizedName = name.trim();
    const timeout = Number.parseInt(idleTimeout, 10);
    if (!normalizedName) {
      setError('Room name is required.');
      return;
    }
    if (!Number.isFinite(timeout) || timeout < 60 || (quota && timeout > quota.max_idle_timeout_seconds)) {
      setError(`Idle timeout must be between 60 and ${quota?.max_idle_timeout_seconds || 86_400} seconds.`);
      return;
    }
    switchOperationRef.current.controller?.abort();
    const generation = switchOperationRef.current.generation + 1;
    const controller = new AbortController();
    switchOperationRef.current = { generation, controller };
    setWorkingId(null);
    setCreating(true);
    setError(null);
    try {
      const created = await createTrainingSession(
        { name: normalizedName, idle_timeout_seconds: timeout },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !openRef.current || switchOperationRef.current.generation !== generation) return;
      setSessions((current) => [...current, created]);
      setName('');
      setStatus(`Created ${created.name}.`);
      onSwitch(created);
      closeLobby();
    } catch (requestError) {
      if (controller.signal.aborted || switchOperationRef.current.generation !== generation || (requestError instanceof ApiError && requestError.code === 'ABORTED')) return;
      setError(requestError instanceof Error ? requestError.message : 'Unable to create the training room.');
    } finally {
      if (switchOperationRef.current.generation === generation) {
        switchOperationRef.current.controller = null;
        setCreating(false);
      }
    }
  };

  const joinRoom = async () => {
    const sessionId = joinId.trim();
    if (!isValidTrainingSessionId(sessionId)) {
      setError('Enter a valid 1–64 character room ID.');
      return;
    }
    switchOperationRef.current.controller?.abort();
    const generation = switchOperationRef.current.generation + 1;
    const controller = new AbortController();
    switchOperationRef.current = { generation, controller };
    setCreating(false);
    setWorkingId(sessionId);
    setError(null);
    try {
      const room = await fetchTrainingSession(sessionId, { signal: controller.signal });
      if (controller.signal.aborted || !openRef.current || switchOperationRef.current.generation !== generation) return;
      onSwitch(room);
      setJoinId('');
      closeLobby();
    } catch (requestError) {
      if (controller.signal.aborted || switchOperationRef.current.generation !== generation || (requestError instanceof ApiError && requestError.code === 'ABORTED')) return;
      setError(requestError instanceof ApiError && requestError.status === 404 ? 'That training room does not exist or has expired.' : requestError instanceof Error ? requestError.message : 'Unable to join the training room.');
    } finally {
      if (switchOperationRef.current.generation === generation) {
        switchOperationRef.current.controller = null;
        setWorkingId(null);
      }
    }
  };

  const keepAlive = async (sessionId: string) => {
    setWorkingId(sessionId);
    setError(null);
    try {
      const updated = await touchTrainingSession(sessionId);
      setSessions((current) => current.map((session) => session.session_id === sessionId ? updated : session));
      setStatus(`${updated.name} expiry extended.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to refresh the room expiry.');
    } finally {
      setWorkingId(null);
    }
  };

  const removeRoom = async (sessionId: string) => {
    setWorkingId(sessionId);
    setError(null);
    try {
      await deleteTrainingSession(sessionId);
      setSessions((current) => current.filter((session) => session.session_id !== sessionId));
      setQuota((current) => current ? { ...current, active_sessions: Math.max(1, current.active_sessions - 1), remaining_sessions: Math.min(current.max_sessions - 1, current.remaining_sessions + 1) } : current);
      setConfirmDeleteId(null);
      setStatus('Training room deleted.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to delete the training room.');
    } finally {
      setWorkingId(null);
    }
  };

  const copyRoomId = async (sessionId: string) => {
    setError(null);
    try {
      await copyText(sessionId);
      setCopiedId(sessionId);
      setStatus('Stable room ID copied.');
      window.setTimeout(() => setCopiedId((current) => current === sessionId ? null : current), 2_000);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Unable to copy the room ID.');
    }
  };

  return (
    <div className="room-lobby-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLobby(); }}>
      <section className="room-lobby" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <header className="room-lobby__header">
          <span className="room-lobby__icon"><Users aria-hidden="true" /></span>
          <div><span className="eyebrow">Isolated runtime orchestration</span><h2 id={titleId}>Training rooms</h2></div>
          {quota && <div className="room-quota"><strong>{quota.active_sessions}/{quota.max_sessions}</strong><span>rooms active</span></div>}
          <button className="icon-button" type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh training rooms"><RefreshCw className={loading ? 'spin' : ''} aria-hidden="true" /></button>
          <button className="icon-button" type="button" onClick={closeLobby} aria-label="Close training room manager" data-dialog-initial-focus><X aria-hidden="true" /></button>
        </header>

        <div className="room-lobby__body">
          <aside className="room-create-panel">
            <section>
              <span className="eyebrow">Create isolated room</span>
              <h3>New training runtime</h3>
              <p>Routes, emergencies, copilot history, clearances, journals, and voice context remain isolated in this room.</p>
              <form onSubmit={(event) => { event.preventDefault(); void createRoom(); }}>
                <label><span>Room name</span><input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="Engine-out recurrent drill" required /></label>
                <label><span>Idle timeout, seconds</span><input type="number" min={60} max={quota?.max_idle_timeout_seconds || 86_400} value={idleTimeout} onChange={(event) => setIdleTimeout(event.target.value)} /></label>
                <small>Default {formatIdle(quota?.default_idle_timeout_seconds || 3_600)} · maximum {formatIdle(quota?.max_idle_timeout_seconds || 86_400)}</small>
                <button className="primary-button" type="submit" disabled={creating || !quota || quota.remaining_sessions === 0}>{creating ? <LoaderCircle className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}Create and enter</button>
              </form>
            </section>
            <section className="room-join-panel">
              <span className="eyebrow">Join by stable ID</span>
              <form onSubmit={(event) => { event.preventDefault(); void joinRoom(); }}><input value={joinId} onChange={(event) => setJoinId(event.target.value)} placeholder="Room UUID or default" aria-label="Stable training room ID" /><button className="secondary-button" type="submit" disabled={workingId === joinId.trim()}><DoorOpen aria-hidden="true" />Join</button></form>
              <p>Room IDs can be shared with another instructor or operator. They are validated before the active cockpit switches.</p>
            </section>
            {quota && <dl className="room-limits"><div><dt>Available rooms</dt><dd>{quota.remaining_sessions}</dd></div><div><dt>WebSockets per room</dt><dd>{quota.max_websocket_clients_per_session}</dd></div><div><dt>Commands per room</dt><dd>{quota.max_commands_per_session}</dd></div><div><dt>Active room</dt><dd title={activeRoom?.session_id}>{activeRoom?.name || activeSessionId.slice(0, 8)}</dd></div></dl>}
          </aside>

          <div className="room-list" aria-live="polite">
            {sessions.map((room) => {
              const active = room.session_id === activeSessionId;
              const deleting = confirmDeleteId === room.session_id;
              return (
                <article className={`room-card ${active ? 'is-active' : ''}`} key={room.session_id}>
                  <header>
                    <span className="room-card__status"><i />{active ? 'Active cockpit' : room.status}</span>
                    {room.is_default && <em>Permanent default</em>}
                    <div className="room-card__header-actions"><button className="icon-button" type="button" onClick={() => void copyRoomId(room.session_id)} aria-label={`Copy ID for ${room.name}`}>{copiedId === room.session_id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button><button className="icon-button" type="button" onClick={() => void keepAlive(room.session_id)} disabled={room.is_default || workingId === room.session_id} aria-label={`Extend expiry for ${room.name}`}><Clock3 aria-hidden="true" /></button></div>
                  </header>
                  <div className="room-card__identity"><div><h3>{room.name}</h3><code title={room.session_id}>{room.session_id}</code></div>{!active && <button className="secondary-button" type="button" onClick={() => { cancelSwitchOperation(); onSwitch(room); closeLobby(); }}><DoorOpen aria-hidden="true" />Enter room</button>}</div>
                  <dl className="room-runtime-grid">
                    <div><dt><Clock3 aria-hidden="true" />Expiry</dt><dd>{room.is_default ? 'Never' : formatDate(room.expires_at)}</dd><small>{room.is_default ? 'Compatibility runtime' : `${formatIdle(room.idle_seconds)} idle of ${formatIdle(room.idle_timeout_seconds)}`}</small></div>
                    <div><dt><Radio aria-hidden="true" />Connections</dt><dd>{room.connected_websocket_clients} WS · {room.active_requests} REST</dd><small>Room-scoped clients</small></div>
                    <div><dt><Server aria-hidden="true" />Runtime</dt><dd title={room.runtime_session_id}>{room.runtime_session_id.slice(0, 8)}</dd><small>Snapshot {room.snapshot_sequence}</small></div>
                    <div><dt><Gauge aria-hidden="true" />Workload</dt><dd>{room.callsign || 'No callsign'}</dd><small>{room.route_id ? 'Route active' : 'No route'} · {room.emergency_id ? 'Emergency' : 'Nominal'}</small></div>
                    <div><dt><Clipboard aria-hidden="true" />Debrief</dt><dd>{room.journal_session_count} journals</dd><small>{room.ai_history_messages} model messages · {room.command_count} commands</small></div>
                  </dl>
                  <footer>
                    {active && <span><Check aria-hidden="true" />REST and WebSocket bound to this room</span>}
                    {!active && !room.is_default && (deleting ? <div className="room-delete-confirm"><span><ShieldAlert aria-hidden="true" />Delete this isolated runtime?</span><button className="danger-button" type="button" disabled={workingId === room.session_id} onClick={() => void removeRoom(room.session_id)}>Confirm delete</button><button className="quiet-button" type="button" onClick={() => setConfirmDeleteId(null)}>Cancel</button></div> : <button className="quiet-button" type="button" onClick={() => setConfirmDeleteId(room.session_id)}><Trash2 aria-hidden="true" />Delete room</button>)}
                    {active && !room.is_default && <small>Switch to another room before deleting this one.</small>}
                  </footer>
                </article>
              );
            })}
            {!loading && !sessions.length && <div className="room-empty"><Users aria-hidden="true" /><strong>No rooms returned</strong><span>The permanent default room should always be available.</span></div>}
          </div>
        </div>

        {(error || status) && <div className={`room-lobby__status ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <ShieldAlert aria-hidden="true" /> : <Check aria-hidden="true" />}<span>{error || status}</span><button type="button" onClick={() => { setError(null); setStatus(null); }} aria-label="Dismiss room manager message"><X aria-hidden="true" /></button></div>}
      </section>
    </div>
  );
}
