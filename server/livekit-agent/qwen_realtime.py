import base64
import json
from urllib.parse import quote

from websockets.asyncio.client import connect


class QwenRealtimeError(RuntimeError):
    pass


def realtime_url(base_url: str, model: str) -> str:
    base = base_url.strip().rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[8:]
    elif base.startswith("http://"):
        base = "ws://" + base[7:]
    if not base.startswith(("ws://", "wss://")):
        raise QwenRealtimeError("REALTIME_URL_INVALID")
    if base.endswith("/realtime"):
        return f"{base}?model={quote(model)}"
    return f"{base}/realtime?model={quote(model)}"


def session_update_event(voice: str, instructions: str) -> dict:
    return {
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "voice": voice or "Cherry",
            "instructions": instructions,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "input_audio_transcription": {"model": "qwen-audio-asr"},
            "turn_detection": {"type": "server_vad", "threshold": 0.5, "silence_duration_ms": 800, "create_response": True},
        },
    }


def append_audio_event(pcm: bytes) -> dict:
    return {"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode()}


def conversation_text_event(text: str) -> dict:
    return {
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": text}],
        },
    }


def response_create_event(modalities: list[str]) -> dict:
    return {"type": "response.create", "response": {"modalities": modalities}}


def parse_server_event(raw: str) -> tuple[str, bytes | str] | None:
    try:
        event = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise QwenRealtimeError("REALTIME_EVENT_INVALID") from exc
    kind = event.get("type") if isinstance(event, dict) else None
    if kind == "response.audio.delta" and isinstance(event.get("delta"), str):
        try:
            return "audio", base64.b64decode(event["delta"], validate=True)
        except ValueError as exc:
            raise QwenRealtimeError("REALTIME_AUDIO_INVALID") from exc
    if kind == "response.audio_transcript.delta" and isinstance(event.get("delta"), str):
        return "output_transcript", event["delta"]
    if kind == "response.text.delta" and isinstance(event.get("delta"), str):
        return "output_text", event["delta"]
    if kind == "conversation.item.input_audio_transcription.completed" and isinstance(event.get("transcript"), str):
        return "input_transcript", event["transcript"]
    if kind == "response.done":
        return "response_done", ""
    if kind == "error":
        raise QwenRealtimeError(str(event.get("error", {}).get("code") or "REALTIME_REMOTE_ERROR"))
    return None


class QwenRealtimeSession:
    def __init__(self, base_url: str, model: str, api_key: str, voice: str, instructions: str) -> None:
        self.url = realtime_url(base_url, model)
        self.api_key = api_key
        self.voice = voice
        self.instructions = instructions
        self.socket = None

    async def __aenter__(self):
        self.socket = await connect(self.url, additional_headers={"Authorization": f"Bearer {self.api_key}", "OpenAI-Beta": "realtime=v1"}, max_size=16 * 1024 * 1024)
        await self.socket.send(json.dumps(session_update_event(self.voice, self.instructions), ensure_ascii=False))
        return self

    async def __aexit__(self, *_args):
        if self.socket is not None:
            await self.socket.close()

    async def send_audio(self, pcm: bytes) -> None:
        if self.socket is None:
            raise QwenRealtimeError("REALTIME_NOT_CONNECTED")
        await self.socket.send(json.dumps(append_audio_event(pcm)))

    async def send_text(self, text: str, modalities: list[str]) -> None:
        if self.socket is None:
            raise QwenRealtimeError("REALTIME_NOT_CONNECTED")
        await self.socket.send(json.dumps(conversation_text_event(text), ensure_ascii=False))
        await self.socket.send(json.dumps(response_create_event(modalities), ensure_ascii=False))

    async def events(self):
        if self.socket is None:
            raise QwenRealtimeError("REALTIME_NOT_CONNECTED")
        async for raw in self.socket:
            if isinstance(raw, str):
                parsed = parse_server_event(raw)
                if parsed is not None:
                    yield parsed


async def run_text_turn(
    base_url: str,
    model: str,
    api_key: str,
    voice: str,
    instructions: str,
    prompt: str,
    *,
    include_audio: bool,
) -> tuple[str, bytes]:
    text_parts: list[str] = []
    audio_parts: list[bytes] = []
    modalities = ["text", "audio"] if include_audio else ["text"]
    async with QwenRealtimeSession(base_url, model, api_key, voice, instructions) as session:
        await session.send_text(prompt, modalities)
        async for kind, value in session.events():
            if kind in {"output_text", "output_transcript"} and isinstance(value, str):
                text_parts.append(value)
            elif kind == "audio" and isinstance(value, bytes):
                audio_parts.append(value)
            elif kind == "response_done":
                break
    text = "".join(text_parts).strip()
    if not text:
        raise QwenRealtimeError("REALTIME_TEXT_EMPTY")
    return text, b"".join(audio_parts)
