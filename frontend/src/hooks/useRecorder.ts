import { useCallback, useEffect, useRef, useState } from 'react';

interface UseRecorderReturn {
  isRecording: boolean;
  startRecording: (deviceId?: string) => Promise<void>;
  stopRecording: () => void;
  audioBlob: Blob | null;
  consumeAudio: () => void;
  error: string | null;
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach(track => track.stop());
}

function microphoneError(error: unknown): string {
  if (!(error instanceof DOMException)) return 'The microphone could not be started.';
  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Allow access in your browser settings and try again.';
    case 'NotFoundError':
      return 'No microphone was found.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy or unavailable.';
    case 'OverconstrainedError':
      return 'The selected microphone is no longer available. Choose another input in Settings.';
    case 'NotSupportedError':
      return 'Audio recording is not supported by this browser.';
    default:
      return error.message || 'The microphone could not be started.';
  }
}

export function useRecorder(): UseRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const consumeAudio = useCallback(() => setAudioBlob(null), []);

  const stopRecording = useCallback(() => {
    stopRequestedRef.current = true;
    const recorder = recorderRef.current;

    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.requestData();
      } catch {
        // Some implementations flush automatically when stop is called.
      }
      try {
        recorder.stop();
      } catch {
        // A simultaneous native stop event can win this race.
      }
    }

    stopStream(streamRef.current);
    streamRef.current = null;
    if (mountedRef.current) setIsRecording(false);
  }, []);

  const startRecording = useCallback(async (deviceId?: string) => {
    if (startingRef.current || (recorderRef.current && recorderRef.current.state !== 'inactive')) return;

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Audio recording is not supported by this browser.');
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    startingRef.current = true;
    stopRequestedRef.current = false;
    setAudioBlob(null);
    setError(null);

    let pendingStream: MediaStream | null = null;
    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };
      pendingStream = await navigator.mediaDevices.getUserMedia(constraints);

      if (!mountedRef.current || stopRequestedRef.current || generation !== generationRef.current) {
        stopStream(pendingStream);
        return;
      }

      const mimeType = MIME_CANDIDATES.find(candidate => MediaRecorder.isTypeSupported(candidate));
      const recorder = mimeType
        ? new MediaRecorder(pendingStream, { mimeType })
        : new MediaRecorder(pendingStream);
      const recordingStream = pendingStream;

      recorderRef.current = recorder;
      streamRef.current = recordingStream;
      chunksRef.current = [];

      recorder.ondataavailable = event => {
        if (generation === generationRef.current && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        if (generation !== generationRef.current || !mountedRef.current) return;
        setError('Recording stopped because the microphone reported an error.');
        setIsRecording(false);
        stopStream(recordingStream);
      };

      recorder.onstop = () => {
        stopStream(recordingStream);
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (streamRef.current === recordingStream) streamRef.current = null;
        if (generation !== generationRef.current || !mountedRef.current) return;

        const chunks = chunksRef.current;
        chunksRef.current = [];
        const size = chunks.reduce((total, chunk) => total + chunk.size, 0);
        if (size > 0) {
          setAudioBlob(new Blob(chunks, {
            type: recorder.mimeType || chunks[0]?.type || 'audio/webm',
          }));
        } else if (!stopRequestedRef.current) {
          setError('No audio was captured. Check the selected microphone and try again.');
        }
        setIsRecording(false);
      };

      recorder.start(250);
      setIsRecording(true);

      if (stopRequestedRef.current) stopRecording();
    } catch (caught) {
      stopStream(pendingStream);
      recorderRef.current = null;
      streamRef.current = null;
      chunksRef.current = [];
      if (mountedRef.current && generation === generationRef.current) {
        setError(microphoneError(caught));
        setIsRecording(false);
      }
    } finally {
      if (generation === generationRef.current) startingRef.current = false;
    }
  }, [stopRecording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRequestedRef.current = true;
      generationRef.current += 1;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
      }
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Recorder was already closing.
        }
      }
      stopStream(streamRef.current);
      streamRef.current = null;
      chunksRef.current = [];
    };
  }, []);

  return { isRecording, startRecording, stopRecording, audioBlob, consumeAudio, error };
}
