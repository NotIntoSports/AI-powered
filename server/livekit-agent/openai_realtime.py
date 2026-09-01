import asyncio
import base64
import json
import logging
from dataclasses import dataclass
from urllib.parse import parse_qs, quote, urlparse, urlunparse

from websockets.asyncio.client import connect


logger = logging.getLogger("livekit-agent")

ALIYUN_REALTIME_PATH = "/api-ws/v1/realtime"
CONNECT_OPEN_TIMEOUT = 10
SESSION_UPDATED_TIMEOUT = 10


class RealtimeError(RuntimeError):
    pass


@dataclass(frozen=True)
class RealtimeDialect:
    name: str
    audio_format: str
    default_voice: str | None


ALIYUN_DIALECT = RealtimeDialect("aliyun", "pcm", None)
OPENAI_DIALECT = RealtimeDialect("openai", "pcm16", "alloy")


class InputTranscriptAssembler:
    def __init__(self) -> None:
        self._texts: dict[str, str] = {}
        self._finalized: set[str] = set()

    def update(self, kind: str, payload: dict) -> tuple[str, str, bool] | None:
        item_id = str(payload.get("item_id") or "").strip()
        if not item_id or item_id in self._finalized:
            return None
        if kind == "input_transcript_completed":
            transcript = str(payload.get("transcript") or "").strip()
            if not transcript:
                return None
            self._texts[item_id] = transcript
            self._finalized.add(item_id)
            return item_id, transcript, True
        if kind != "input_transcript_delta":
            return None
        stable = str(payload.get("text") or "")
        stash = str(payload.get("stash") or "")
        delta = str(payload.get("delta") or "")
        text = stable + stash if stable or stash else self._texts.get(item_id, "") + delta
        text = text.strip()
        if not text:
            return None
        self._texts[item_id] = text
        return item_id, text, False


def _websocket_scheme(scheme: str) -> str:
    if scheme == "https":
        return "wss"
    if scheme == "http":
        return "ws"
    return scheme


def realtime_dialect(base_url: str) -> RealtimeDialect:
    parsed = urlparse(base_url.strip())
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    is_aliyun = (
        "compatible-mode" in path
        or path.rstrip("/").endswith(ALIYUN_REALTIME_PATH)
        or "dashscope" in host
        or "token-plan" in host
    )
    return ALIYUN_DIALECT if is_aliyun else OPENAI_DIALECT


def realtime_url(base_url: str, model: str) -> str:
    raw = base_url.strip().rstrip("/")
    parsed = urlparse(raw)
    scheme = _websocket_scheme(parsed.scheme)
    if scheme not in {"ws", "wss"} or not parsed.netloc:
        raise RealtimeError("REALTIME_URL_INVALID")
    dialect = realtime_dialect(raw)
    path = parsed.path.rstrip("/")
    if dialect is ALIYUN_DIALECT:
        path = ALIYUN_REALTIME_PATH
    elif not path.endswith("/realtime"):
        path = f"{path}/realtime"
    return urlunparse((scheme, parsed.netloc, path, "", f"model={quote(model)}", ""))


def realtime_log_fields(url: str) -> dict:
    parsed = urlparse(url)
    model = (parse_qs(parsed.query).get("model") or [""])[0]
    return {"host": parsed.hostname or "", "path": parsed.path, "model": model}


def session_update_event(voice: str, instructions: str, dialect: RealtimeDialect) -> dict:
    session = {
        "modalities": ["text", "audio"],
        "instructions": instructions,
        "input_audio_format": dialect.audio_format,
        "output_audio_format": dialect.audio_format,
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "silence_duration_ms": 800,
            "create_response": True,
        },
    }
    selected_voice = voice or dialect.default_voice
    if selected_voice:
        session["voice"] = selected_voice
    return {
        "type": "session.update",
        "session": session,
    }


def realtime_error_code(exc: BaseException) -> str:
    if isinstance(exc, BaseExceptionGroup):
        parts = [realtime_error_code(item) for item in exc.exceptions]
        joined = ";".join(part for part in parts if part)
        return joined[:80] or type(exc).__name__
    text = str(exc).strip()
    return (text or type(exc).__name__)[:80]


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


def parse_server_event(raw: str) -> tuple[str, bytes | str | dict] | None:
    try:
        event = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RealtimeError("REALTIME_EVENT_INVALID") from exc
    kind = event.get("type") if isinstance(event, dict) else None
    if kind == "response.audio.delta" and isinstance(event.get("delta"), str):
        try:
            return "audio", base64.b64decode(event["delta"], validate=True)
        except ValueError as exc:
            raise RealtimeError("REALTIME_AUDIO_INVALID") from exc
    if kind == "response.audio_transcript.delta" and isinstance(event.get("delta"), str):
        return "output_transcript", event["delta"]
    if kind == "response.text.delta" and isinstance(event.get("delta"), str):
        return "output_text", event["delta"]
    if kind == "conversation.item.input_audio_transcription.delta":
        return "input_transcript_delta", {
            "item_id": str(event.get("item_id") or ""),
            "delta": event.get("delta") if isinstance(event.get("delta"), str) else "",
            "text": event.get("text") if isinstance(event.get("text"), str) else "",
            "stash": event.get("stash") if isinstance(event.get("stash"), str) else "",
        }
    if kind == "conversation.item.input_audio_transcription.completed" and isinstance(event.get("transcript"), str):
        return "input_transcript_completed", {
            "item_id": str(event.get("item_id") or ""),
            "transcript": event["transcript"],
        }
    if kind == "response.done":
        return "response_done", ""
    if kind == "session.updated":
        return "session_updated", ""
    if kind == "session.created":
        return "session_created", ""
    if kind == "error":
        error = event.get("error") if isinstance(event.get("error"), dict) else {}
        code = str(error.get("code") or "REALTIME_REMOTE_ERROR")[:80]
        message = str(error.get("message") or "")[:80]
        raise RealtimeError(f"{code}:{message}" if message else code)
    return None


class RealtimeSession:
    def __init__(self, base_url: str, model: str, api_key: str, voice: str, instructions: str) -> None:
        self.url = realtime_url(base_url, model)
        self.dialect = realtime_dialect(base_url)
        self.api_key = api_key
        self.voice = voice
        self.instructions = instructions
        self.socket = None

    async def __aenter__(self):
        logger.info(json.dumps({"event": "realtime_connecting", **realtime_log_fields(self.url)}))
        try:
            self.socket = await connect(
                self.url,
                additional_headers={"Authorization": f"Bearer {self.api_key}", "OpenAI-Beta": "realtime=v1"},
                max_size=16 * 1024 * 1024,
                open_timeout=CONNECT_OPEN_TIMEOUT,
            )
        except RealtimeError:
            raise
        except Exception as exc:
            raise RealtimeError(str(exc)[:80] or "REALTIME_CONNECT_FAILED") from exc
        await self.socket.send(json.dumps(session_update_event(self.voice, self.instructions, self.dialect), ensure_ascii=False))
        await self.wait_session_updated()
        logger.info(json.dumps({"event": "realtime_session_updated", **realtime_log_fields(self.url)}))
        return self

    async def wait_session_updated(self) -> None:
        if self.socket is None:
            raise RealtimeError("REALTIME_NOT_CONNECTED")
        deadline = asyncio.get_running_loop().time() + SESSION_UPDATED_TIMEOUT
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise RealtimeError("REALTIME_SESSION_UPDATE_TIMEOUT")
            try:
                raw = await asyncio.wait_for(self.socket.recv(), timeout=remaining)
            except TimeoutError as exc:
                raise RealtimeError("REALTIME_SESSION_UPDATE_TIMEOUT") from exc
            if not isinstance(raw, str):
                continue
            parsed = parse_server_event(raw)
            if parsed is None or parsed[0] == "session_created":
                continue
            if parsed[0] == "session_updated":
                return
            raise RealtimeError(f"REALTIME_SESSION_UPDATE_UNEXPECTED:{parsed[0]}")

    async def __aexit__(self, *_args):
        if self.socket is not None:
            await self.socket.close()

    async def send_audio(self, pcm: bytes) -> None:
        if self.socket is None:
            raise RealtimeError("REALTIME_NOT_CONNECTED")
        await self.socket.send(json.dumps(append_audio_event(pcm)))

    async def send_text(self, text: str, modalities: list[str]) -> None:
        if self.socket is None:
            raise RealtimeError("REALTIME_NOT_CONNECTED")
        await self.socket.send(json.dumps(conversation_text_event(text), ensure_ascii=False))
        await self.socket.send(json.dumps(response_create_event(modalities), ensure_ascii=False))

    async def events(self):
        if self.socket is None:
            raise RealtimeError("REALTIME_NOT_CONNECTED")
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
    async with RealtimeSession(base_url, model, api_key, voice, instructions) as session:
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
        raise RealtimeError("REALTIME_TEXT_EMPTY")
    return text, b"".join(audio_parts)
