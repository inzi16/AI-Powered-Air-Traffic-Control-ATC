"""
Edge TTS Module — Generates spoken ATC audio responses.
"""

import edge_tts
import io


# Male, authoritative voices suitable for ATC
VOICES = {
    "male_us": "en-US-GuyNeural",
    "male_uk": "en-GB-RyanNeural",
    "male_au": "en-AU-WilliamNeural",
    "female_us": "en-US-JennyNeural",
    "female_uk": "en-GB-SoniaNeural",
}

DEFAULT_VOICE = "en-GB-RyanNeural"
DEFAULT_RATE = "+12%"
DEFAULT_PITCH = "-5Hz"


async def generate_speech(text: str, voice: str | None = None, rate: str | None = None) -> bytes:
    """Generate MP3 audio bytes from text using Edge TTS."""
    v = voice or DEFAULT_VOICE
    r = rate or DEFAULT_RATE

    communicate = edge_tts.Communicate(
        text=text,
        voice=v,
        rate=r,
        pitch=DEFAULT_PITCH,
    )

    buffer = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buffer.write(chunk["data"])

    return buffer.getvalue()


def get_available_voices() -> list[dict]:
    return [
        {"id": k, "name": v, "label": k.replace("_", " ").title()}
        for k, v in VOICES.items()
    ]
