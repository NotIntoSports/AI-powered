import base64
import io
import json
import logging
import struct
import uuid
import wave
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SAMPLE_RATE = 16_000
MIN_SPEECH_MS = 400
SILENCE_MS = 900
MAX_BUFFER_MS = 20_000
RMS_THRESHOLD = 350

logger = logging.getLogger("livekit-agent.e2e")


class E2EModelError(RuntimeError):
    pass


@dataclass(frozen=True)
class E2EConfig:
    base_url: str
    model: str
    api_key: str
    timeout_ms: int = 60_000
    language: str = "zh"
    enabled: bool = True

    @classmethod
    def from_dict(cls, payload: dict) -> "E2EConfig":
        base_url = str(payload.get("baseUrl") or payload.get("base_url") or "").strip().rstrip("/")
        model = str(payload.get("model") or "").strip()
        api_key = str(payload.get("apiKey") or payload.get("api_key") or "").strip()
        timeout_ms = payload.get("questionTimeoutMs") or payload.get("question_timeout_ms") or 60_000
        if not isinstance(timeout_ms, int) or timeout_ms <= 0:
            timeout_ms = 60_000
        language = str(payload.get("language") or "zh").strip() or "zh"
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            enabled = True
        if not base_url:
            raise E2EModelError("E2E_BASE_URL_MISSING")
        if not model:
            raise E2EModelError("E2E_MODEL_MISSING")
        if not api_key:
            raise E2EModelError("E2E_API_KEY_MISSING")
        return cls(
            base_url=base_url,
            model=model,
            api_key=api_key,
            timeout_ms=timeout_ms,
            language=language,
            enabled=enabled,
        )


@dataclass(frozen=True)
class E2EResult:
    utterance_id: str
    transcript: str
    reply: str


def pcm_rms(pcm: bytes) -> float:
    if len(pcm) < 2:
        return 0.0
    count = len(pcm) // 2
    total = 0
    for index in range(0, count * 2, 2):
        sample = struct.unpack_from("<h", pcm, index)[0]
        total += sample * sample
    return (total / count) ** 0.5


def pcm_to_wav_base64(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> str:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _system_prompt(language: str) -> str:
    lang_hint = "中文" if language.startswith("zh") else language
    return (
        "你是面试助手。用户消息包含会议中对方说话的音频。"
        f"请只返回 JSON 对象，不要 Markdown：{{\"transcript\":\"对方原话\",\"reply\":\"你的下一句回复\"}}。"
        f"transcript 为音频转写，reply 为你要说的话，使用{lang_hint}，简洁自然。"
        "reply 只输出要对对方说的话，不含角色标签或解释。"
    )


def _extract_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if not stripped:
        raise E2EModelError("E2E_EMPTY_RESPONSE")
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start >= 0 and end > start:
        parsed = json.loads(stripped[start : end + 1])
        if isinstance(parsed, dict):
            return parsed
    raise E2EModelError("E2E_INVALID_JSON")


def build_chat_request(config: E2EConfig, pcm: bytes) -> dict[str, Any]:
    audio_b64 = pcm_to_wav_base64(pcm)
    return {
        "model": config.model,
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": _system_prompt(config.language)},
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {"data": audio_b64, "format": "wav"},
                    }
                ],
            },
        ],
    }


def chat_completions_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"


def call_e2e(config: E2EConfig, pcm: bytes, utterance_id: str | None = None) -> E2EResult:
    if not config.enabled:
        raise E2EModelError("E2E_DISABLED")
    if len(pcm) < SAMPLE_RATE * 2 * MIN_SPEECH_MS // 1000:
        raise E2EModelError("E2E_AUDIO_TOO_SHORT")
    body = json.dumps(build_chat_request(config, pcm)).encode("utf-8")
    request = Request(
        chat_completions_url(config.base_url),
        data=body,
        headers={
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    timeout_sec = max(config.timeout_ms / 1000, 5)
    try:
        with urlopen(request, timeout=timeout_sec) as response:
            payload = json.load(response)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise E2EModelError(f"E2E_HTTP_{exc.code}:{detail}") from exc
    except URLError as exc:
        raise E2EModelError("E2E_UNREACHABLE") from exc
    except TimeoutError as exc:
        raise E2EModelError("E2E_TIMEOUT") from exc

    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list) or not choices:
        raise E2EModelError("E2E_NO_CHOICES")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise E2EModelError("E2E_EMPTY_CONTENT")

    parsed = _extract_json_object(content)
    transcript = str(parsed.get("transcript") or parsed.get("text") or "").strip()
    reply = str(parsed.get("reply") or parsed.get("response") or parsed.get("answer") or "").strip()
    if not transcript:
        raise E2EModelError("E2E_MISSING_TRANSCRIPT")
    if not reply:
        raise E2EModelError("E2E_MISSING_REPLY")
    return E2EResult(
        utterance_id=utterance_id or str(uuid.uuid4()),
        transcript=transcript,
        reply=reply,
    )


class AudioTurnBuffer:
    def __init__(
        self,
        sample_rate: int = SAMPLE_RATE,
        min_speech_ms: int = MIN_SPEECH_MS,
        silence_ms: int = SILENCE_MS,
        max_buffer_ms: int = MAX_BUFFER_MS,
        rms_threshold: float = RMS_THRESHOLD,
    ) -> None:
        self.sample_rate = sample_rate
        self.min_speech_bytes = sample_rate * 2 * min_speech_ms // 1000
        self.silence_bytes = sample_rate * 2 * silence_ms // 1000
        self.max_buffer_bytes = sample_rate * 2 * max_buffer_ms // 1000
        self.rms_threshold = rms_threshold
        self._buffer = bytearray()
        self._speech_started = False
        self._trailing_silence = 0

    def push(self, pcm: bytes) -> bytes | None:
        if not pcm:
            return None
        rms = pcm_rms(pcm)
        voiced = rms >= self.rms_threshold
        if voiced:
            self._speech_started = True
            self._trailing_silence = 0
            self._buffer.extend(pcm)
        elif self._speech_started:
            self._buffer.extend(pcm)
            self._trailing_silence += len(pcm)

        if not self._speech_started:
            return None

        ready = False
        if len(self._buffer) >= self.max_buffer_bytes:
            ready = True
        elif (
            self._trailing_silence >= self.silence_bytes
            and len(self._buffer) >= self.min_speech_bytes
        ):
            ready = True

        if not ready:
            return None

        chunk = bytes(self._buffer)
        self.reset()
        return chunk

    def reset(self) -> None:
        self._buffer.clear()
        self._speech_started = False
        self._trailing_silence = 0
