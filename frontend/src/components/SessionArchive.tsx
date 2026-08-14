import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  Bookmark,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Database,
  Download,
  FileJson,
  Flag,
  LoaderCircle,
  Pencil,
  Plus,
  Radio,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  createTimelineBookmark,
  deleteTimelineBookmark,
  fetchJournalEvents,
  fetchJournalExport,
  fetchJournalReplay,
  listJournalSessions,
  listCommandAudit,
  listTimelineBookmarks,
  updateTimelineBookmark,
  type BookmarkCategory,
  type CommandAuditPage,
  type JournalEventRecord,
  type JournalReplayResponse,
  type JournalSessionSummary,
  type TimelineBookmark,
} from '../api';

type ArchiveTab = 'events' | 'replay' | 'bookmarks' | 'commands';
type SemanticFilter = 'all' | 'session' | 'flight' | 'scenario' | 'emergency' | 'communications';

interface Props {
  open: boolean;
  currentSessionId: string;
  onClose: () => void;
}

interface BookmarkDraft {
  title: string;
  annotation: string;
  category: BookmarkCategory;
  tags: string;
  event?: JournalEventRecord;
}

const EMPTY_BOOKMARK: BookmarkDraft = { title: '', annotation: '', category: 'bookmark', tags: '' };

const COMMON_EVENT_TYPES = [
  '',
  'session.reset',
  'scenario.paused',
  'scenario.resumed',
  'scenario.time_scale_changed',
  'scenario.loaded',
  'route.created',
  'route.engaged',
  'route.cancelled',
  'emergency.activated',
  'emergency.action_updated',
  'emergency.resolved',
  'alert.acknowledged',
  'alert.unacknowledged',
  'clearance.issued',
  'clearance.accepted',
  'chat.responded',
];

function isFocusable(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && !element.hasAttribute('disabled') && element.tabIndex !== -1;
}

function semanticCategory(eventType: string): Exclude<SemanticFilter, 'all'> {
  if (eventType.startsWith('session.') || eventType.startsWith('snapshot.')) return 'session';
  if (eventType.startsWith('route.')) return 'flight';
  if (eventType.startsWith('emergency.') || eventType.startsWith('alert.')) return 'emergency';
  if (eventType.startsWith('chat.') || eventType.startsWith('clearance.') || eventType.includes('atc')) return 'communications';
  return 'scenario';
}

function iconForEvent(eventType: string): ReactNode {
  const category = semanticCategory(eventType);
  if (category === 'emergency') return <TriangleAlert aria-hidden="true" />;
  if (category === 'flight') return <Flag aria-hidden="true" />;
  if (category === 'communications') return <Radio aria-hidden="true" />;
  if (category === 'session') return <Database aria-hidden="true" />;
  return <Archive aria-hidden="true" />;
}

function formatDate(value: string | null): string {
  if (!value) return 'Open';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const remainder = whole % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
}

function eventSummary(event: JournalEventRecord): string {
  const payload = event.payload;
  const preferred = ['title', 'message', 'summary', 'status', 'callsign', 'action_id']
    .flatMap((key) => typeof payload[key] === 'string' || typeof payload[key] === 'number' ? [`${key}: ${String(payload[key])}`] : []);
  if (preferred.length) return preferred.slice(0, 2).join(' · ');
  const keys = Object.keys(payload);
  return keys.length ? `Payload: ${keys.slice(0, 4).join(', ')}` : 'No event payload';
}

function eventMatchesSearch(event: JournalEventRecord, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  const payload = JSON.stringify(event.payload).slice(0, 4_000).toLowerCase();
  return `${event.metadata.event_type} ${event.metadata.event_id} ${payload}`.includes(query);
}

function downloadExport(sessionId: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/vnd.smart-atc.session+json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `smart-atc-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function SessionArchive({ open, currentSessionId, onClose }: Props) {
  const [sessions, setSessions] = useState<JournalSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [tab, setTab] = useState<ArchiveTab>('events');
  const [events, setEvents] = useState<JournalEventRecord[]>([]);
  const [eventsAfter, setEventsAfter] = useState<number | null>(null);
  const [eventsHaveMore, setEventsHaveMore] = useState(false);
  const [eventTypeDraft, setEventTypeDraft] = useState('');
  const [eventType, setEventType] = useState('');
  const [semanticFilter, setSemanticFilter] = useState<SemanticFilter>('all');
  const [eventSearch, setEventSearch] = useState('');
  const [replayFrom, setReplayFrom] = useState('1');
  const [replayTo, setReplayTo] = useState('');
  const [replayRequest, setReplayRequest] = useState({ from: 1, to: undefined as number | undefined, revision: 0 });
  const [replay, setReplay] = useState<JournalReplayResponse | null>(null);
  const [bookmarks, setBookmarks] = useState<TimelineBookmark[]>([]);
  const [commandAudit, setCommandAudit] = useState<CommandAuditPage | null>(null);
  const [bookmarkDraft, setBookmarkDraft] = useState<BookmarkDraft>(EMPTY_BOOKMARK);
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [deleteBookmarkId, setDeleteBookmarkId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const selectedSession = sessions.find((session) => session.session_id === selectedSessionId) || null;
  const filteredEvents = useMemo(() => events.filter((event) => (
    (semanticFilter === 'all' || semanticCategory(event.metadata.event_type) === semanticFilter)
    && eventMatchesSearch(event, eventSearch)
  )), [eventSearch, events, semanticFilter]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('button')?.focus());
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll('button, input, textarea, select, [tabindex]')].filter(isFocusable);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listJournalSessions(50, { signal: controller.signal })
      .then((items) => {
        setSessions(items);
        const selected = items.find((item) => item.session_id === currentSessionId) || items[0];
        if (!selected) return;
        setSelectedSessionId(selected.session_id);
        const first = selected.first_event_sequence || 1;
        setReplayFrom(String(first));
        setReplayTo('');
        setReplayRequest((current) => ({ from: first, to: undefined, revision: current.revision + 1 }));
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'Unable to load the session archive.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [currentSessionId, open]);

  useEffect(() => {
    if (!open || !selectedSessionId || tab !== 'events') return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchJournalEvents(selectedSessionId, { limit: 50, event_type: eventType || undefined }, { signal: controller.signal })
      .then((page) => {
        setEvents(page.events);
        setEventsAfter(page.next_after_event_sequence);
        setEventsHaveMore(page.has_more);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'Unable to load journal events.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [eventType, open, selectedSessionId, tab]);

  useEffect(() => {
    if (!open || !selectedSessionId || tab !== 'replay') return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchJournalReplay(selectedSessionId, { from_event_sequence: replayRequest.from, to_event_sequence: replayRequest.to, limit: 75 }, { signal: controller.signal })
      .then(setReplay)
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'Unable to reconstruct the journal range.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, replayRequest, selectedSessionId, tab]);

  useEffect(() => {
    if (!open || !selectedSessionId || tab !== 'bookmarks') return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listTimelineBookmarks(selectedSessionId, { signal: controller.signal })
      .then(setBookmarks)
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'Unable to load bookmarks.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, selectedSessionId, tab]);

  useEffect(() => {
    if (!open || tab !== 'commands') return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listCommandAudit({ limit: 100 }, { signal: controller.signal })
      .then(setCommandAudit)
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'Unable to load the command audit.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, tab]);

  if (!open) return null;

  const selectSession = (session: JournalSessionSummary) => {
    setSelectedSessionId(session.session_id);
    setEvents([]);
    setReplay(null);
    setBookmarks([]);
    setBookmarkDraft(EMPTY_BOOKMARK);
    setEditingBookmarkId(null);
    setDeleteBookmarkId(null);
    setError(null);
    setStatus(null);
    const first = session.first_event_sequence || 1;
    setReplayFrom(String(first));
    setReplayTo('');
    setReplayRequest((current) => ({ from: first, to: undefined, revision: current.revision + 1 }));
  };

  const loadMoreEvents = async () => {
    if (!selectedSessionId || !eventsAfter) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchJournalEvents(selectedSessionId, { after_event_sequence: eventsAfter, limit: 50, event_type: eventType || undefined });
      setEvents((current) => [...current, ...page.events]);
      setEventsAfter(page.next_after_event_sequence);
      setEventsHaveMore(page.has_more);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load more events.');
    } finally {
      setLoadingMore(false);
    }
  };

  const loadMoreReplay = async () => {
    if (!selectedSessionId || !replay?.next_after_event_sequence) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchJournalReplay(selectedSessionId, { from_event_sequence: replayRequest.from, to_event_sequence: replayRequest.to, after_event_sequence: replay.next_after_event_sequence, limit: 75 });
      setReplay((current) => current ? { ...page, checkpoint: current.checkpoint, events: [...current.events, ...page.events] } : page);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load more replay events.');
    } finally {
      setLoadingMore(false);
    }
  };

  const startBookmark = (event?: JournalEventRecord) => {
    setBookmarkDraft({ ...EMPTY_BOOKMARK, title: event ? event.metadata.event_type.replaceAll('.', ' ') : '', event });
    setEditingBookmarkId(null);
    setDeleteBookmarkId(null);
    setTab('bookmarks');
  };

  const editBookmark = (bookmark: TimelineBookmark) => {
    setEditingBookmarkId(bookmark.bookmark_id);
    setBookmarkDraft({ title: bookmark.title, annotation: bookmark.annotation, category: bookmark.category, tags: bookmark.tags.join(', ') });
    setDeleteBookmarkId(null);
  };

  const saveBookmark = async () => {
    const title = bookmarkDraft.title.trim();
    if (!selectedSessionId || !title) {
      setError('Bookmark title is required.');
      return;
    }
    const tags = bookmarkDraft.tags.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    setSaving(true);
    setError(null);
    try {
      if (editingBookmarkId) {
        const updated = await updateTimelineBookmark(selectedSessionId, editingBookmarkId, { title, annotation: bookmarkDraft.annotation, category: bookmarkDraft.category, tags });
        setBookmarks((current) => current.map((bookmark) => bookmark.bookmark_id === updated.bookmark_id ? updated : bookmark));
        setStatus('Bookmark updated.');
      } else {
        const created = await createTimelineBookmark(selectedSessionId, {
          title,
          annotation: bookmarkDraft.annotation,
          category: bookmarkDraft.category,
          tags,
          ...(bookmarkDraft.event ? { event_id: bookmarkDraft.event.metadata.event_id, event_sequence: bookmarkDraft.event.metadata.event_sequence } : {}),
        });
        setBookmarks((current) => [...current, created]);
        setSessions((current) => current.map((session) => session.session_id === selectedSessionId ? { ...session, bookmark_count: session.bookmark_count + 1 } : session));
        setStatus('Bookmark created.');
      }
      setBookmarkDraft(EMPTY_BOOKMARK);
      setEditingBookmarkId(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save the bookmark.');
    } finally {
      setSaving(false);
    }
  };

  const removeBookmark = async (bookmarkId: string) => {
    if (!selectedSessionId) return;
    setSaving(true);
    setError(null);
    try {
      await deleteTimelineBookmark(selectedSessionId, bookmarkId);
      setBookmarks((current) => current.filter((bookmark) => bookmark.bookmark_id !== bookmarkId));
      setSessions((current) => current.map((session) => session.session_id === selectedSessionId ? { ...session, bookmark_count: Math.max(0, session.bookmark_count - 1) } : session));
      setDeleteBookmarkId(null);
      setStatus('Bookmark deleted.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to delete the bookmark.');
    } finally {
      setSaving(false);
    }
  };

  const exportSession = async () => {
    if (!selectedSessionId) return;
    setExporting(true);
    setError(null);
    try {
      const exported = await fetchJournalExport(selectedSessionId);
      downloadExport(selectedSessionId, exported);
      setStatus(`JSON export includes manifest ${exported.manifest_checksum.slice(0, 12)}…`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to export the session.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="session-archive-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="session-archive" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <header className="session-archive__header">
          <span className="session-archive__icon"><Archive aria-hidden="true" /></span>
          <div><span className="eyebrow">Debrief workspace</span><h2 id={titleId}>Session archive</h2></div>
          <button className="secondary-button" type="button" disabled={!selectedSessionId || exporting} onClick={() => void exportSession()}>{exporting ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}Export JSON</button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close session archive"><X aria-hidden="true" /></button>
        </header>

        <div className="session-archive__layout">
          <aside className="session-list" aria-label="Retained training sessions">
            <header><strong>Retained sessions</strong><span>{sessions.length}</span></header>
            <div className="session-list__scroll">
              {sessions.map((session) => (
                <button key={session.session_id} className={session.session_id === selectedSessionId ? 'is-active' : ''} type="button" onClick={() => selectSession(session)} aria-pressed={session.session_id === selectedSessionId}>
                  <span><strong>{session.current ? 'Current session' : formatDate(session.created_at)}</strong>{session.current && <em>Live</em>}</span>
                  <small>{session.session_id.slice(0, 8)} · {session.retained_event_count} events</small>
                  <span className="session-list__counts"><i>{session.checkpoint_count} checkpoints</i><i>{session.bookmark_count} bookmarks</i></span>
                </button>
              ))}
              {!loading && !sessions.length && <div className="archive-empty"><Database aria-hidden="true" /><span>No journal sessions are retained.</span></div>}
            </div>
          </aside>

          <main className="session-detail">
            {selectedSession ? (
              <>
                <section className="session-summary" aria-label="Selected session summary">
                  <div><span className="eyebrow">Session</span><strong>{selectedSession.session_id}</strong></div>
                  <dl>
                    <div><dt>Status</dt><dd>{selectedSession.current ? 'Current' : 'Closed'}</dd></div>
                    <div><dt>Simulation time</dt><dd>{formatElapsed(selectedSession.simulation_time_seconds)}</dd></div>
                    <div><dt>Retained events</dt><dd>{selectedSession.retained_event_count}/{selectedSession.event_count}</dd></div>
                    <div><dt>Storage</dt><dd>{selectedSession.storage_backend}</dd></div>
                  </dl>
                  {selectedSession.truncated_before_event_sequence > 0 && <div className="retention-warning"><TriangleAlert aria-hidden="true" />Events through sequence {selectedSession.truncated_before_event_sequence} were removed by bounded retention.</div>}
                </section>

                <nav className="archive-tabs" aria-label="Session archive views">
                  <button type="button" className={tab === 'events' ? 'is-active' : ''} aria-current={tab === 'events' ? 'page' : undefined} onClick={() => setTab('events')}><FileJson aria-hidden="true" />Events</button>
                  <button type="button" className={tab === 'replay' ? 'is-active' : ''} aria-current={tab === 'replay' ? 'page' : undefined} onClick={() => setTab('replay')}><BookOpen aria-hidden="true" />Read-only replay</button>
                  <button type="button" className={tab === 'bookmarks' ? 'is-active' : ''} aria-current={tab === 'bookmarks' ? 'page' : undefined} onClick={() => setTab('bookmarks')}><Bookmark aria-hidden="true" />Bookmarks <span>{selectedSession.bookmark_count}</span></button>
                  <button type="button" className={tab === 'commands' ? 'is-active' : ''} aria-current={tab === 'commands' ? 'page' : undefined} onClick={() => setTab('commands')}><ClipboardCheck aria-hidden="true" />Command audit <span>{commandAudit?.retained_count ?? 0}</span></button>
                </nav>

                {tab === 'events' && (
                  <section className="archive-pane">
                    <form className="event-filters" onSubmit={(event) => { event.preventDefault(); setEventType(eventTypeDraft.trim()); }}>
                      <label><span>Exact event type</span><select value={eventTypeDraft} onChange={(event) => setEventTypeDraft(event.target.value)}>{COMMON_EVENT_TYPES.map((type) => <option key={type || 'all'} value={type}>{type || 'All event types'}</option>)}</select></label>
                      <label><span>Semantic group</span><select value={semanticFilter} onChange={(event) => setSemanticFilter(event.target.value as SemanticFilter)}><option value="all">All groups</option><option value="session">Session</option><option value="flight">Flight and route</option><option value="scenario">Scenario control</option><option value="emergency">Emergency</option><option value="communications">Communications</option></select></label>
                      <label className="event-search"><span>Search loaded events</span><div><Search aria-hidden="true" /><input value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} placeholder="Payload, event ID, or type" /></div></label>
                      <button className="secondary-button" type="submit">Apply</button>
                    </form>
                    <div className="journal-event-list">
                      {filteredEvents.map((event) => (
                        <article className={`journal-event is-${semanticCategory(event.metadata.event_type)}`} key={event.metadata.event_id}>
                          <span className="journal-event__icon">{iconForEvent(event.metadata.event_type)}</span>
                          <div className="journal-event__copy"><div><strong>{event.metadata.event_type}</strong><time>{formatDate(event.recorded_at)}</time></div><p>{eventSummary(event)}</p><small>Event {event.metadata.event_sequence} · snapshot {event.snapshot_sequence} · revision {event.metadata.state_revision} · sim {formatElapsed(event.simulation_time_seconds)}</small></div>
                          <div className="journal-event__meta"><code title={event.state_checksum}>{event.state_checksum.slice(0, 10)}…</code>{event.payload_truncated && <span>Payload truncated</span>}<button className="quiet-button" type="button" onClick={() => startBookmark(event)}><Bookmark aria-hidden="true" />Bookmark</button></div>
                        </article>
                      ))}
                      {!loading && !filteredEvents.length && <div className="archive-empty"><Search aria-hidden="true" /><span>No loaded events match these filters.</span></div>}
                    </div>
                    {eventsHaveMore && <button className="archive-load-more" type="button" disabled={loadingMore} onClick={() => void loadMoreEvents()}>{loadingMore && <LoaderCircle className="spin" aria-hidden="true" />}Load next event page</button>}
                  </section>
                )}

                {tab === 'replay' && (
                  <section className="archive-pane replay-pane">
                    <div className="readonly-notice"><BookOpen aria-hidden="true" /><div><strong>Historical journal reconstruction</strong><span>Read-only data for debrief. It never moves, pauses, or changes the live exercise.</span></div></div>
                    <form className="replay-range" onSubmit={(event) => {
                      event.preventDefault();
                      const from = Math.max(1, Number.parseInt(replayFrom, 10) || 1);
                      const parsedTo = replayTo.trim() ? Math.max(from, Number.parseInt(replayTo, 10) || from) : undefined;
                      setReplayRequest((current) => ({ from, to: parsedTo, revision: current.revision + 1 }));
                    }}>
                      <label><span>From event</span><input type="number" min="1" value={replayFrom} onChange={(event) => setReplayFrom(event.target.value)} /></label>
                      <label><span>Through event</span><input type="number" min="1" value={replayTo} onChange={(event) => setReplayTo(event.target.value)} placeholder="Latest retained" /></label>
                      <button className="secondary-button" type="submit">Reconstruct range</button>
                    </form>
                    {replay && (
                      <>
                        <div className={`replay-integrity ${replay.complete_from_requested_sequence ? 'is-complete' : 'is-partial'}`}>
                          {replay.complete_from_requested_sequence ? <ShieldCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
                          <div><span className="eyebrow">Retention integrity</span><strong>{replay.complete_from_requested_sequence ? 'Requested range is reconstructable' : 'Requested range has a retention gap'}</strong><p>{replay.complete_from_requested_sequence ? 'The checkpoint precedes the requested event and the retained event chain is complete.' : 'The archive does not claim complete history before the earliest retained checkpoint.'}</p></div>
                          <dl><div><dt>Checkpoint event</dt><dd>{replay.checkpoint.event_sequence}</dd></div><div><dt>Snapshot</dt><dd>{replay.checkpoint.snapshot_sequence}</dd></div><div><dt>Simulation time</dt><dd>{formatElapsed(replay.checkpoint.simulation_time_seconds)}</dd></div><div><dt>State checksum</dt><dd><code title={replay.checkpoint.state_checksum}>{replay.checkpoint.state_checksum.slice(0, 12)}…</code></dd></div></dl>
                        </div>
                        <div className="replay-event-chain" aria-label="Read-only replay event chain">
                          {replay.events.map((event) => <article key={event.metadata.event_id}><span>{event.metadata.event_sequence}</span><div><strong>{event.metadata.event_type}</strong><small>Snapshot {event.snapshot_sequence} · {formatElapsed(event.simulation_time_seconds)}</small></div><code title={event.state_checksum}>{event.state_checksum.slice(0, 10)}…</code>{event.payload_truncated && <em>Truncated</em>}</article>)}
                        </div>
                        {replay.has_more && <button className="archive-load-more" type="button" disabled={loadingMore} onClick={() => void loadMoreReplay()}>{loadingMore && <LoaderCircle className="spin" aria-hidden="true" />}Load next replay page</button>}
                      </>
                    )}
                  </section>
                )}

                {tab === 'bookmarks' && (
                  <section className="archive-pane bookmark-pane">
                    <form className="bookmark-editor" onSubmit={(event) => { event.preventDefault(); void saveBookmark(); }}>
                      <header><div><span className="eyebrow">{editingBookmarkId ? 'Edit annotation' : 'New annotation'}</span><strong>{bookmarkDraft.event ? `Event ${bookmarkDraft.event.metadata.event_sequence}: ${bookmarkDraft.event.metadata.event_type}` : 'Session bookmark'}</strong></div>{!editingBookmarkId && <button className="quiet-button" type="button" onClick={() => startBookmark()}><Plus aria-hidden="true" />New</button>}</header>
                      <div className="bookmark-form-grid">
                        <label className="is-wide"><span>Title</span><input maxLength={120} value={bookmarkDraft.title} onChange={(event) => setBookmarkDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Decision point or review topic" required /></label>
                        <label><span>Category</span><select value={bookmarkDraft.category} onChange={(event) => setBookmarkDraft((current) => ({ ...current, category: event.target.value as BookmarkCategory }))}><option value="bookmark">Bookmark</option><option value="incident">Incident</option><option value="training">Training</option><option value="review">Review</option></select></label>
                        <label><span>Tags, comma separated</span><input value={bookmarkDraft.tags} onChange={(event) => setBookmarkDraft((current) => ({ ...current, tags: event.target.value }))} placeholder="crm, separation" /></label>
                        <label className="is-wide"><span>Annotation</span><textarea maxLength={4000} value={bookmarkDraft.annotation} onChange={(event) => setBookmarkDraft((current) => ({ ...current, annotation: event.target.value }))} placeholder="What happened, why it mattered, and what to review" /></label>
                      </div>
                      <div className="bookmark-editor__actions"><button className="quiet-button" type="button" onClick={() => { setBookmarkDraft(EMPTY_BOOKMARK); setEditingBookmarkId(null); }}>Clear</button><button className="primary-button" type="submit" disabled={saving || !bookmarkDraft.title.trim()}>{saving && <LoaderCircle className="spin" aria-hidden="true" />}{editingBookmarkId ? 'Save changes' : 'Create bookmark'}</button></div>
                    </form>
                    <div className="bookmark-list">
                      {bookmarks.map((bookmark) => (
                        <article key={bookmark.bookmark_id}>
                          <span className={`bookmark-category is-${bookmark.category}`}><Bookmark aria-hidden="true" /></span>
                          <div><div><strong>{bookmark.title}</strong><small>{bookmark.category}</small></div>{bookmark.annotation && <p>{bookmark.annotation}</p>}<span>{bookmark.event_sequence ? `Event ${bookmark.event_sequence}` : `Snapshot ${bookmark.snapshot_sequence}`} · {bookmark.created_by} · {formatDate(bookmark.updated_at)}</span>{bookmark.tags.length > 0 && <ul>{bookmark.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>}</div>
                          <div className="bookmark-actions"><button className="icon-button" type="button" onClick={() => editBookmark(bookmark)} aria-label={`Edit ${bookmark.title}`}><Pencil aria-hidden="true" /></button>{deleteBookmarkId === bookmark.bookmark_id ? <><button className="danger-button" type="button" disabled={saving} onClick={() => void removeBookmark(bookmark.bookmark_id)}>Confirm</button><button className="quiet-button" type="button" onClick={() => setDeleteBookmarkId(null)}>Cancel</button></> : <button className="icon-button" type="button" onClick={() => setDeleteBookmarkId(bookmark.bookmark_id)} aria-label={`Delete ${bookmark.title}`}><Trash2 aria-hidden="true" /></button>}</div>
                        </article>
                      ))}
                      {!loading && !bookmarks.length && <div className="archive-empty"><Bookmark aria-hidden="true" /><span>No bookmarks in this session.</span></div>}
                    </div>
                  </section>
                )}

                {tab === 'commands' && (
                  <section className="archive-pane">
                    <div className="readonly-notice"><ClipboardCheck aria-hidden="true" /><div><strong>Current training-room command ledger</strong><span>Single-use command identities, snapshot preconditions, outcomes, and rejection reasons. This audit is room-scoped and read-only.</span></div></div>
                    <div className="journal-event-list">
                      {commandAudit?.commands.map((item) => (
                        <article className={`journal-event is-${item.status === 'rejected' ? 'emergency' : 'session'}`} key={item.command.command_id}>
                          <span className="journal-event__icon">{item.status === 'succeeded' ? <CheckCircle2 aria-hidden="true" /> : item.status === 'rejected' ? <TriangleAlert aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}</span>
                          <div className="journal-event__copy"><div><strong>{item.operation}</strong><time>{formatDate(item.completed_at || item.received_at)}</time></div><p>{item.status === 'rejected' ? `${item.error_code || 'rejected'}: ${item.error_detail || 'Command was not committed.'}` : item.status === 'pending' ? 'Awaiting an authoritative ledger outcome.' : `Committed by ${item.command.actor}.`}</p><small>Sequence {item.sequence_before} → {item.sequence_after ?? 'pending'} · revision {item.revision_before} → {item.revision_after ?? 'pending'}</small></div>
                          <div className="journal-event__meta"><code title={item.command.command_id}>{item.command.command_id.slice(0, 18)}…</code><span>{item.legacy ? 'Legacy request' : 'Revision-bound'}</span>{item.deduplicated_count > 0 && <span>{item.deduplicated_count} deduplicated replay{item.deduplicated_count === 1 ? '' : 's'}</span>}</div>
                        </article>
                      ))}
                      {!loading && !commandAudit?.commands.length && <div className="archive-empty"><ClipboardCheck aria-hidden="true" /><span>No commands are retained in this training room.</span></div>}
                    </div>
                    {commandAudit && <div className="readonly-notice"><Database aria-hidden="true" /><div><strong>{commandAudit.retained_count} of {commandAudit.max_retained} bounded ledger slots used</strong><span>Oldest command records are removed when room retention reaches its configured limit.</span></div></div>}
                  </section>
                )}
              </>
            ) : <div className="archive-empty archive-empty--full">{loading ? <LoaderCircle className="spin" aria-hidden="true" /> : <Archive aria-hidden="true" />}<span>{loading ? 'Loading retained sessions' : 'Select a retained session to begin.'}</span></div>}
          </main>
        </div>

        {(error || status) && <div className={`archive-status ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <TriangleAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}<span>{error || status}</span><button type="button" onClick={() => { setError(null); setStatus(null); }} aria-label="Dismiss message"><X aria-hidden="true" /></button></div>}
      </div>
    </div>
  );
}
