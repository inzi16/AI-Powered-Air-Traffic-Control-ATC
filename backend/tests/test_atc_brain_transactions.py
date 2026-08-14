from __future__ import annotations

import asyncio

import atc_brain
from atc_brain import ATCBrain


def test_chat_generation_is_pure_and_commit_exchange_is_explicit(monkeypatch):
    captured: dict = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"message": {"content": "TXN101, heading two seven zero approved"}}

    class FakeAsyncClient:
        def __init__(self, *, timeout: float) -> None:
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, _exc_type, _exc, _traceback) -> None:
            return None

        async def post(self, url: str, *, json: dict):
            captured["url"] = url
            captured["messages"] = json["messages"]
            return FakeResponse()

    monkeypatch.setattr(atc_brain.httpx, "AsyncClient", FakeAsyncClient)
    brain = ATCBrain()
    brain.commit_exchange("TXN101 radio check", "TXN101, readability five")
    committed_before = [dict(item) for item in brain.conversation_history]

    reply = asyncio.run(brain.chat(
        "TXN101 request heading two seven zero",
        {"lat": 0.0, "lon": 0.0, "altitude": 10_000, "heading_mag": 90},
        {"phase": "CRUISE", "phase_label": "Cruise", "vertical_rate": 0},
    ))

    assert reply == "TXN101, heading two seven zero approved"
    assert brain.conversation_history == committed_before
    assert captured["timeout"] == atc_brain.OLLAMA_HTTP_TIMEOUT_SECONDS
    assert captured["timeout"] < 60.0
    assert captured["messages"][-1] == {
        "role": "user",
        "content": "TXN101 request heading two seven zero",
    }

    brain.commit_exchange("TXN101 request heading two seven zero", reply)
    assert brain.conversation_history == [
        {"role": "user", "content": "TXN101 radio check"},
        {"role": "assistant", "content": "TXN101, readability five"},
        {"role": "user", "content": "TXN101 request heading two seven zero"},
        {"role": "assistant", "content": reply},
    ]


def test_ollama_timeout_default_and_bounds_stay_below_proxy(monkeypatch):
    monkeypatch.delenv("OLLAMA_HTTP_TIMEOUT_SECONDS", raising=False)
    assert atc_brain._ollama_timeout_seconds() == 45.0

    monkeypatch.setenv("OLLAMA_HTTP_TIMEOUT_SECONDS", "60")
    assert atc_brain._ollama_timeout_seconds() == 55.0
    monkeypatch.setenv("OLLAMA_HTTP_TIMEOUT_SECONDS", "not-a-number")
    assert atc_brain._ollama_timeout_seconds() == 45.0
    monkeypatch.setenv("OLLAMA_HTTP_TIMEOUT_SECONDS", "nan")
    assert atc_brain._ollama_timeout_seconds() == 45.0

