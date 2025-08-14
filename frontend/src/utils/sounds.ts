// Sound utility — generates aviation-style cues with the Web Audio API only.
//
// All sounds are synthesized at runtime, no asset files required.

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let _muted = false;

function getContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(audioCtx.destination);
  }
  return audioCtx;
}

export function setMuted(muted: boolean) {
  _muted = muted;
  if (masterGain) masterGain.gain.value = muted ? 0 : 1.0;
}

export function setMasterVolume(v: number) {
  if (masterGain) masterGain.gain.value = Math.max(0, Math.min(1, v));
}

function tone(freq: number, duration: number, volume = 0.15, type: OscillatorType = 'sine', delay = 0) {
  if (_muted) return;
  try {
    const ctx = getContext();
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(masterGain || ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  } catch { /* ignore */ }
}

export function playBeep(freq = 800, duration = 0.12, volume = 0.15) {
  tone(freq, duration, volume);
}

// ---- Radio chatter cues -----------------------------------------------------

export function playRadioClick() {
  if (_muted) return;
  try {
    const ctx = getContext();
    const buf = ctx.createBuffer(1, 800, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / 60);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2500;
    const gain = ctx.createGain();
    gain.gain.value = 0.18;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain || ctx.destination);
    src.start();
  } catch { /* ignore */ }
}

export function playPTTStart() {
  playRadioClick();
  tone(1700, 0.05, 0.1, 'square');
}
export function playPTTEnd() {
  tone(1300, 0.05, 0.08, 'square');
  setTimeout(playRadioClick, 30);
}

export function playMessageSent() {
  tone(560, 0.07, 0.07);
}

export function playATCResponse() {
  tone(660, 0.07, 0.09, 'sine', 0);
  tone(990, 0.06, 0.1, 'sine', 0.08);
}

// ---- Cabin chime (the classic 3-note "bing-bong") ---------------------------

export function playCabinChime() {
  tone(523.25, 0.6, 0.18, 'sine', 0);
  tone(659.25, 0.7, 0.15, 'sine', 0.18);
  tone(523.25, 0.5, 0.12, 'sine', 0.55);
}

// ---- Caution / warning ------------------------------------------------------

export function playCaution() {
  tone(540, 0.25, 0.18, 'triangle');
}

export function playEmergencyAlert() {
  for (let i = 0; i < 3; i++) {
    tone(820, 0.16, 0.22, 'square', i * 0.22);
    tone(1100, 0.16, 0.18, 'square', i * 0.22 + 0.04);
  }
}

export function playTCASTraffic() {
  tone(900, 0.1, 0.18, 'square', 0);
  tone(1300, 0.1, 0.18, 'square', 0.12);
  tone(900, 0.1, 0.18, 'square', 0.28);
}

export function playSOS() {
  const short = 0.08, gap = 0.1, letterGap = 0.25;
  let t = 0;
  for (let g = 0; g < 3; g++) {
    for (let i = 0; i < 3; i++) { tone(1000, short, 0.2, 'sine', t); t += short + gap; }
    t += letterGap;
  }
}

// ---- Engine spool-up (intro background) ------------------------------------

let _spoolNode: { osc: OscillatorNode; gain: GainNode } | null = null;

export function startEngineSpool(durationSec = 6) {
  stopEngineSpool();
  if (_muted) return;
  try {
    const ctx = getContext();
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(60, t0);
    osc.frequency.exponentialRampToValueAtTime(180, t0 + durationSec);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.07, t0 + 1.2);
    gain.gain.linearRampToValueAtTime(0.05, t0 + durationSec - 0.5);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain || ctx.destination);
    osc.start(t0);
    _spoolNode = { osc, gain };
  } catch { /* ignore */ }
}

export function stopEngineSpool() {
  if (!_spoolNode) return;
  try {
    const ctx = getContext();
    const t = ctx.currentTime;
    _spoolNode.gain.gain.cancelScheduledValues(t);
    _spoolNode.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    _spoolNode.osc.stop(t + 0.7);
  } catch { /* ignore */ }
  _spoolNode = null;
}

// ---- Frequency-change cue --------------------------------------------------

export function playFreqChange() {
  tone(440, 0.06, 0.1, 'triangle');
  tone(660, 0.08, 0.1, 'triangle', 0.05);
}
