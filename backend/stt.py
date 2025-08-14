"""
Speech-to-Text Module — Uses faster-whisper for transcription.
"""

model = None

try:
    from faster_whisper import WhisperModel
    model = WhisperModel(
        "base",
        device="cpu",
        compute_type="int8",
    )
except Exception as e:
    print(f"[STT] Warning: Could not load whisper model: {e}")
    print("[STT] Speech-to-text will not be available. Install faster-whisper and ffmpeg.")


def transcribe(audio_path: str) -> str:
    if model is None:
        return "(Speech-to-text unavailable — install faster-whisper and ffmpeg)"
    try:
        segments, _info = model.transcribe(audio_path)
        text = "".join(seg.text for seg in segments)
        return text.strip()
    except Exception as e:
        print(f"[STT] Transcription error: {e}")
        return "(Transcription failed — check audio format)"
