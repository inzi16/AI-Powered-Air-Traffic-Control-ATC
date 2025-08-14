import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Loader2,
  Mic,
  Radio,
  Send,
  ShieldAlert,
  Sparkles,
  Waypoints,
} from 'lucide-react';
import { acceptClearance, fetchTTS, sendChat, sendSTT } from '../api';
import { usePTT } from '../hooks/usePTT';
import { useRecorder } from '../hooks/useRecorder';
import type { SimData } from '../hooks/useSimData';
import { getTimestamp } from '../utils/format';
import { playATCResponse, playMessageSent, playPTTEnd, playPTTStart } from '../utils/sounds';

export interface ChatMessage {
  id: string;
  role: 'pilot' | 'atc' | 'system';
  text: string;
  timestamp: string;
  confidence?: number;
  clearanceId?: string;
}

interface Advisory {
  id?: string;
  title?: string;
  action?: string;
  summary?: string;
  rationale?: string[] | string;
  confidence?: number;
  sources?: string[];
  severity?: string;
  alternatives?: Array<{ title?: string; action?: string }>;
}

type EnrichedSimData = SimData;

interface ChatPanelProps {
  className?: string;
  sim: EnrichedSimData;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  ttsEnabled: boolean;
  ttsVoice: string;
  pttKey: string;
  micDeviceId: string;
  speakerDeviceId?: string;
  pttEnabled?: boolean;
  onCallsignUpdate?: (callsign: string) => void;
  onApplyAdvisory?: (advisory: Advisory) => Promise<void> | void;
  onEmergencyAction?: (actionId: string) => Promise<void> | void;
}

export default function ChatPanel({
  className = '',
  sim,
  messages,
  setMessages,
  ttsEnabled,
  ttsVoice,
  pttKey,
  micDeviceId,
  speakerDeviceId = '',
  pttEnabled = true,
  onCallsignUpdate,
  onApplyAdvisory,
  onEmergencyAction,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sttProcessing, setSttProcessing] = useState(false);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [pendingClearance, setPendingClearance] = useState<{ id: string; reply: string } | null>(null);
  const [readback, setReadback] = useState('');
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const inputRef = useRef(input);
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const activeAudioUrl = useRef<string | null>(null);
  const { isRecording, startRecording, stopRecording, audioBlob, consumeAudio, error: recorderError } = useRecorder();
  inputRef.current = input;

  const advisory = useMemo<Advisory>(() => {
    if (sim.active_emergency?.actions.length) {
      const next = sim.active_emergency.actions.find((step) => step.status !== 'completed');
      return {
        id: next?.id || 'emergency-monitor',
        title: next?.label || 'Monitor emergency state',
        action: next?.description || 'Continue the emergency checklist',
        rationale: [`${sim.active_emergency.title || sim.active_emergency.type || 'Emergency'} mode is active`, 'Complete actions in priority order', 'Reassess after every state change'],
        confidence: 1,
        sources: ['Deterministic emergency workflow', 'Simulator telemetry'],
        severity: 'emergency',
      };
    }
    const backendAdvisory = sim.recommendation || sim.advisories?.[0];
    if (backendAdvisory) return {
      id: backendAdvisory.id,
      title: backendAdvisory.title,
      action: backendAdvisory.message,
      rationale: [backendAdvisory.message],
      confidence: .88,
      sources: [backendAdvisory.source],
      severity: backendAdvisory.severity,
    };
    if (sim.conflicts?.length) {
      const conflict = sim.conflicts[0];
      return {
        id: 'conflict-monitor',
        title: `Monitor ${conflict.callsign}`,
        action: 'Await validated resolution guidance',
        rationale: [`Current separation ${conflict.range_nm.toFixed(1)} NM`, `Vertical difference ${Math.round(conflict.alt_diff_ft)} ft`, 'No maneuver is committed without validation'],
        confidence: .72,
        sources: ['Conflict monitor', 'Traffic snapshot'],
        severity: 'warning',
      };
    }
    return {
      id: 'steady-state',
      title: sim.phase === 'UNKNOWN' ? 'Connect or plan a flight' : `Continue ${sim.phase_label || sim.phase}`,
      action: sim.phase === 'UNKNOWN' ? 'Start a global route demo to activate flight intelligence' : 'Maintain the current validated flight plan',
      rationale: sim.phase === 'UNKNOWN' ? ['No authoritative flight is active'] : ['No immediate conflict detected', 'Telemetry is within the expected envelope'],
      confidence: sim.phase === 'UNKNOWN' ? .45 : .9,
      sources: ['Rules-derived phase state', 'Telemetry-derived separation state'],
      severity: 'normal',
    };
  }, [sim.active_emergency, sim.advisories, sim.conflicts, sim.phase, sim.phase_label, sim.recommendation]);

  const addMessage = useCallback((role: ChatMessage['role'], text: string, confidence?: number) => {
    setMessages((current) => [...current, { id: crypto.randomUUID(), role, text, timestamp: getTimestamp(), confidence }]);
  }, [setMessages]);

  const playReply = useCallback(async (text: string) => {
    if (!ttsEnabled || !text) return;
    activeAudio.current?.pause();
    if (activeAudioUrl.current) URL.revokeObjectURL(activeAudioUrl.current);
    try {
      const blob = await fetchTTS(text, ttsVoice || undefined);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      if (speakerDeviceId && 'setSinkId' in audio) {
        try {
          await (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(speakerDeviceId);
        } catch {
          // Browsers may expose output selection but reject the chosen device.
        }
      }
      activeAudio.current = audio;
      activeAudioUrl.current = url;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        activeAudioUrl.current = null;
        activeAudio.current = null;
      };
      await audio.play();
    } catch {
      if (activeAudioUrl.current) URL.revokeObjectURL(activeAudioUrl.current);
      activeAudioUrl.current = null;
      activeAudio.current = null;
    }
  }, [speakerDeviceId, ttsEnabled, ttsVoice]);

  const handleSend = useCallback(async (override?: string) => {
    const message = (override ?? inputRef.current).trim();
    if (!message || loadingRef.current) return;
    loadingRef.current = true;
    playMessageSent();
    addMessage('pilot', message);
    setInput('');
    setLoading(true);
    try {
      const response = await sendChat(message);
      const reply = typeof response.reply === 'string' ? response.reply : 'Unable to produce a validated response. Say again.';
      addMessage('atc', reply, typeof response.confidence === 'number' ? response.confidence : undefined);
      if (response.requires_acceptance && response.clearance?.clearance_id) {
        setPendingClearance({ id: response.clearance.clearance_id, reply });
        setReadback('');
        addMessage('system', 'Clearance issued but not executed. Review and accept with a readback to commit the targets.');
      }
      if (typeof response.callsign === 'string' && response.callsign) onCallsignUpdate?.(response.callsign);
      playATCResponse();
      await playReply(reply);
    } catch (error) {
      addMessage('system', error instanceof Error ? error.message : 'ATC service is unavailable. Your flight state was not changed.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [addMessage, onCallsignUpdate, playReply]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [loading, messages]);

  useEffect(() => {
    if (!audioBlob) return;
    let cancelled = false;
    setSttProcessing(true);
    sendSTT(audioBlob)
      .then((text) => { if (!cancelled && text) return handleSend(text); })
      .catch((error) => { if (!cancelled) addMessage('system', error instanceof Error ? error.message : 'Voice transcription failed.'); })
      .finally(() => { if (!cancelled) { consumeAudio(); setSttProcessing(false); } });
    return () => { cancelled = true; };
  }, [addMessage, audioBlob, consumeAudio, handleSend]);

  useEffect(() => () => {
    activeAudio.current?.pause();
    if (activeAudioUrl.current) URL.revokeObjectURL(activeAudioUrl.current);
  }, []);

  const beginPTT = useCallback(() => { playPTTStart(); void startRecording(micDeviceId || undefined); }, [micDeviceId, startRecording]);
  const endPTT = useCallback(() => { playPTTEnd(); stopRecording(); }, [stopRecording]);
  usePTT(pttKey, beginPTT, endPTT, pttEnabled && !loading);

  const confidence = Math.max(0, Math.min(1, advisory.confidence ?? .75));
  const rationale = Array.isArray(advisory.rationale) ? advisory.rationale : advisory.rationale ? [advisory.rationale] : [];

  return (
    <aside className={`copilot-rail ${className}`} aria-label="AI copilot and emergency coach">
      <header className="copilot-header">
        <div className="copilot-title"><Sparkles aria-hidden="true" />AI copilot</div>
        <span className="live-label"><span className="mode-dot" />{sim.active_emergency ? 'Emergency' : 'Live'}</span>
      </header>

      <div className="copilot-scroll">
        {sim.active_emergency && sim.active_emergency.actions.length > 0 && (
          <section className="emergency-card" aria-labelledby="emergency-coach-title">
            <header className="emergency-card__header"><ShieldAlert aria-hidden="true" /><strong id="emergency-coach-title">{sim.active_emergency.title || 'Emergency mode'}</strong></header>
            <ol className="emergency-steps">
              {sim.active_emergency.actions.map((step) => {
                const complete = step.status === 'completed';
                return (
                <li key={step.id} className={`emergency-step ${complete ? 'is-complete' : ''}`}>
                  <button type="button" aria-label={`${complete ? 'Completed' : 'Complete'} ${step.label}`} disabled={complete} onClick={() => onEmergencyAction?.(step.id)}>{complete && <Check size={14} aria-hidden="true" />}</button>
                  <div><strong>{step.label}</strong><span>{step.description}</span></div>
                  <em>{step.category || 'Next'}</em>
                </li>
                );
              })}
            </ol>
          </section>
        )}

        <section className="recommendation">
          <h2>Next best action</h2>
          <div className="recommendation-card">
            <div className="recommendation-card__title"><span>{advisory.severity === 'emergency' ? <ShieldAlert /> : <Waypoints />}</span><span>{advisory.title || 'Review guidance'}</span></div>
            <ul>{rationale.slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ul>
            <div className="recommendation-actions">
              <button className="primary-button" type="button" onClick={() => onApplyAdvisory?.(advisory)}><CheckCircle2 size={16} aria-hidden="true" />{advisory.action || 'Acknowledge guidance'}</button>
              {advisory.alternatives?.length ? <button className="secondary-button" type="button" onClick={() => setShowAlternatives((current) => !current)}>{showAlternatives ? 'Hide alternatives' : 'View alternatives'}</button> : null}
            </div>
            {showAlternatives && advisory.alternatives?.map((alternative) => <button className="quiet-button" type="button" key={alternative.title || alternative.action}>{alternative.title || alternative.action}</button>)}
          </div>
        </section>

        <section className="insight-section">
          <h3>Confidence</h3>
          <div className="confidence-row">
            <div className="confidence-meter" aria-label={`${Math.round(confidence * 100)} percent confidence`}>{[.2, .4, .6, .8, 1].map((threshold) => <span key={threshold} className={confidence >= threshold ? 'is-filled' : ''} />)}</div>
            <span className="confidence-number">{Math.round(confidence * 100)}%</span>
          </div>
        </section>

        <section className="insight-section">
          <h3>Provenance</h3>
          <ul className="provenance-list">{(advisory.sources || ['Flight state', 'Rules engine']).map((source) => <li key={source}><span>{source}</span><strong>{source.toLowerCase().includes('simulator') || source.toLowerCase().includes('telemetry') ? 'observed' : 'rules-derived'}</strong></li>)}</ul>
        </section>

        <section className="chat-transcript" aria-label="ATC transcript" aria-live="polite">
          {messages.slice(-8).map((message) => (
            <article key={message.id} className={`chat-message is-${message.role}`}>
              {message.text}
              <div className="chat-message__meta"><span>{message.role === 'pilot' ? 'PILOT' : message.role.toUpperCase()}</span><time>{message.timestamp}</time></div>
            </article>
          ))}
          {loading && <article className="chat-message"><Loader2 size={14} className="spin" aria-hidden="true" /> Validating transmission…</article>}
          {pendingClearance && (
            <article className="clearance-card">
              <span className="eyebrow">Pending clearance</span>
              <p>{pendingClearance.reply}</p>
              <label><span className="sr-only">Pilot readback</span><input value={readback} onChange={(event) => setReadback(event.target.value)} placeholder="Read back every assigned heading, altitude, speed or instruction" /></label>
              <div>
                <button className="secondary-button" type="button" onClick={() => setPendingClearance(null)}>Hold</button>
                <button className="primary-button" type="button" disabled={!readback.trim()} onClick={async () => {
                  try {
                    await acceptClearance(pendingClearance.id, readback.trim());
                    addMessage('system', 'Clearance accepted. Validated targets are now executing.');
                    setPendingClearance(null);
                  } catch (error) {
                    addMessage('system', error instanceof Error ? error.message : 'Clearance acceptance failed.');
                  }
                }}>Accept and read back</button>
              </div>
            </article>
          )}
          <div ref={transcriptEnd} />
        </section>
      </div>

      <div className="chat-composer">
        <div className="voice-ready">
          <button className={`voice-button ${isRecording ? 'is-recording' : ''}`} type="button" onPointerDown={beginPTT} onPointerUp={endPTT} onPointerCancel={endPTT} aria-label={isRecording ? 'Release to transcribe' : 'Hold to talk'}>
            {sttProcessing ? <Loader2 className="spin" aria-hidden="true" /> : isRecording ? <Radio aria-hidden="true" /> : <Mic aria-hidden="true" />}
          </button>
          <input className="composer-input" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleSend(); } }} placeholder={recorderError || `Message ATC · hold ${pttKey.replace('Key', '')} to talk`} aria-label="Message ATC" disabled={loading || isRecording} />
          <button className="composer-send" type="button" onClick={() => void handleSend()} disabled={!input.trim() || loading} aria-label="Send message"><Send aria-hidden="true" /></button>
        </div>
      </div>
    </aside>
  );
}
