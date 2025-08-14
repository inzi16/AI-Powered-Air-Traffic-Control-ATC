import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Accessibility,
  BellRing,
  Keyboard,
  Mic,
  Moon,
  Palette,
  RefreshCw,
  Sun,
  Volume2,
  X,
} from 'lucide-react';
import { useTheme } from '../context/theme';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  ttsEnabled: boolean;
  setTtsEnabled: (value: boolean) => void;
  ttsVoice: string;
  setTtsVoice: (value: string) => void;
  pttKey: string;
  setPttKey: (value: string) => void;
  micDeviceId: string;
  setMicDeviceId: (value: string) => void;
  speakerDeviceId: string;
  setSpeakerDeviceId: (value: string) => void;
  introSoundEnabled?: boolean;
  setIntroSoundEnabled?: (value: boolean) => void;
  reducedMotion?: boolean;
  setReducedMotion?: (value: boolean) => void;
}

const INTRO_SOUND_KEY = 'skycommand:intro-sound';
const REDUCED_MOTION_KEY = 'skycommand:reduced-motion';

function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function saveBooleanPreference(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage can be unavailable in privacy-restricted contexts.
  }
}

export default function SettingsModal({
  open,
  onClose,
  ttsEnabled,
  setTtsEnabled,
  ttsVoice,
  setTtsVoice,
  pttKey,
  setPttKey,
  micDeviceId,
  setMicDeviceId,
  speakerDeviceId,
  setSpeakerDeviceId,
  introSoundEnabled,
  setIntroSoundEnabled,
  reducedMotion,
  setReducedMotion,
}: SettingsModalProps) {
  const { theme, toggleTheme } = useTheme();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [capturingKey, setCapturingKey] = useState(false);
  const [localIntroSound, setLocalIntroSound] = useState(() =>
    readBooleanPreference(INTRO_SOUND_KEY, true),
  );
  const [localReducedMotion, setLocalReducedMotion] = useState(() => {
    const systemPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    return readBooleanPreference(REDUCED_MOTION_KEY, systemPreference);
  });

  const soundEnabled = introSoundEnabled ?? localIntroSound;
  const motionReduced = reducedMotion ?? localReducedMotion;
  const effectivePttKey = !pttKey || pttKey === 'Tab' ? 'Space' : pttKey;

  const requestClose = useCallback(() => {
    setCapturingKey(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    closeRef.current = requestClose;
  }, [requestClose]);

  useEffect(() => {
    if (!pttKey || pttKey === 'Tab') setPttKey('Space');
  }, [pttKey, setPttKey]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    });

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter(element => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

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

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleDialogKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setAudioInputs(devices.filter(device => device.kind === 'audioinput'));
        setAudioOutputs(devices.filter(device => device.kind === 'audiooutput'));
        setDeviceError(null);
      } catch {
        if (!cancelled) setDeviceError('Audio devices are unavailable in this browser context.');
      }
    };

    void refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !capturingKey) return;
    const capture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setCapturingKey(false);
        return;
      }
      // Tab always remains available for keyboard navigation and can never be PTT.
      if (event.code === 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      setPttKey(event.code || 'Space');
      setCapturingKey(false);
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [capturingKey, open, setPttKey]);

  const authorizeMicrophone = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setDeviceError('Microphone capture is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(devices.filter(device => device.kind === 'audioinput'));
      setAudioOutputs(devices.filter(device => device.kind === 'audiooutput'));
      setDeviceError(null);
    } catch (error) {
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      setDeviceError(denied
        ? 'Microphone access was denied. Update the site permission to use voice input.'
        : 'The selected microphone could not be opened.');
    }
  };

  const updateIntroSound = (value: boolean) => {
    setLocalIntroSound(value);
    saveBooleanPreference(INTRO_SOUND_KEY, value);
    setIntroSoundEnabled?.(value);
  };

  const updateReducedMotion = (value: boolean) => {
    setLocalReducedMotion(value);
    saveBooleanPreference(REDUCED_MOTION_KEY, value);
    setReducedMotion?.(value);
  };

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <div className="eyebrow">Console preferences</div>
            <h2 id={titleId}>Settings</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => closeRef.current()}
            aria-label="Close settings"
            data-initial-focus
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="modal-copy">
          <p id={descriptionId}>
            Configure the controller workspace, voice channel, and accessible startup experience.
          </p>

          <div className="form-grid">
            <SettingsSection icon={<Palette />} title="Appearance">
              <span className="form-help">Current theme: {theme}</span>
              <button className="secondary-button" type="button" onClick={toggleTheme}>
                {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
                Use {theme === 'dark' ? 'light' : 'dark'} theme
              </button>
            </SettingsSection>

            <SettingsSection icon={<Accessibility />} title="Motion">
              <span className="form-help">Shortens startup animation and removes engine spool.</span>
              <ToggleButton
                checked={motionReduced}
                onChange={updateReducedMotion}
                label="Reduced motion"
              />
            </SettingsSection>

            <SettingsSection icon={<Mic />} title="Audio input">
              <label htmlFor="settings-microphone">Microphone</label>
              <select
                id="settings-microphone"
                value={micDeviceId}
                onChange={event => setMicDeviceId(event.target.value)}
              >
                <option value="">System default</option>
                {audioInputs.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </select>
              <button className="secondary-button" type="button" onClick={authorizeMicrophone}>
                <RefreshCw aria-hidden="true" />
                Authorize and refresh
              </button>
              {deviceError && <span className="form-help" role="alert">{deviceError}</span>}
            </SettingsSection>

            <SettingsSection icon={<Volume2 />} title="Audio output">
              <label htmlFor="settings-speaker">Speaker</label>
              <select
                id="settings-speaker"
                value={speakerDeviceId}
                onChange={event => setSpeakerDeviceId(event.target.value)}
              >
                <option value="">System default</option>
                {audioOutputs.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Speaker ${index + 1}`}
                  </option>
                ))}
              </select>
              <span className="form-help">Output selection is applied where the browser supports audio sinks.</span>
            </SettingsSection>

            <SettingsSection icon={<Volume2 />} title="Controller voice">
              <ToggleButton checked={ttsEnabled} onChange={setTtsEnabled} label="ATC text to speech" />
              <label htmlFor="settings-voice">Voice</label>
              <select
                id="settings-voice"
                value={ttsVoice}
                onChange={event => setTtsVoice(event.target.value)}
                disabled={!ttsEnabled}
              >
                <option value="en-GB-RyanNeural">Ryan — British English</option>
                <option value="en-US-GuyNeural">Guy — American English</option>
                <option value="en-AU-WilliamNeural">William — Australian English</option>
                <option value="en-US-JennyNeural">Jenny — American English</option>
                <option value="en-GB-SoniaNeural">Sonia — British English</option>
              </select>
            </SettingsSection>

            <SettingsSection icon={<BellRing />} title="Cabin intro">
              <span className="form-help">Sound only starts after you select Enter cockpit.</span>
              <ToggleButton checked={soundEnabled} onChange={updateIntroSound} label="Cabin chime" />
            </SettingsSection>

            <SettingsSection icon={<Keyboard />} title="Push to talk" wide>
              <label htmlFor="settings-ptt-key">Keyboard shortcut</label>
              <button
                id="settings-ptt-key"
                className="secondary-button"
                type="button"
                onClick={() => setCapturingKey(true)}
                aria-pressed={capturingKey}
              >
                <Keyboard aria-hidden="true" />
                {capturingKey ? 'Press a key · Escape cancels' : effectivePttKey}
              </button>
              <span className="form-help">Space is the safe default. Tab is always reserved for navigation.</span>
            </SettingsSection>
          </div>

          <footer className="modal-actions">
            <button className="primary-button" type="button" onClick={() => closeRef.current()}>
              Done
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

function SettingsSection({
  icon,
  title,
  children,
  wide = false,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`form-field${wide ? ' is-wide' : ''}`}>
      <div className="eyebrow">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function ToggleButton({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      className="secondary-button"
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span>{label}</span>
      <strong>{checked ? 'On' : 'Off'}</strong>
    </button>
  );
}
