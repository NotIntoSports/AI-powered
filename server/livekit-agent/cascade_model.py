import asyncio
import io
import json
import uuid
import wave
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from voice_route import ModelEndpoint


class CascadeModelError(RuntimeError):
    pass


def _endpoint_url(base_url: str, suffix: str) -> str:
    normalized = base_url.rstrip("/")
    return normalized if normalized.endswith(suffix) else f"{normalized}/{suffix.lstrip('/')}"


def build_llm_request(endpoint: ModelEndpoint, candidate_text: str, context: dict[str, Any]) -> dict[str, Any]:
    role = str(context.get("role") or "assistant")
    topic = str(context.get("topic") or "")
    messages: list[dict[str, str]] = [{
        "role": "system",
        "content": f"你是实时语音助手，当前角色是 {role}，主题是 {topic}。回复简洁自然，只输出需要说的话。",
    }]
    history = context.get("history")
    if isinstance(history, list):
        for item in history[-20:]:
            if not isinstance(item, dict):
                continue
            item_role = "assistant" if item.get("role") in {"assistant", "interviewer"} else "user"
            text = str(item.get("text") or "").strip()
            if text:
                messages.append({"role": item_role, "content": text[:4000]})
    messages.append({"role": "user", "content": candidate_text.strip()})
    return {"model": endpoint.model_id, "messages": messages, "temperature": 0.3}


def build_tts_request(endpoint: ModelEndpoint, text: str, voice_id: str) -> dict[str, Any]:
    return {
        "model": endpoint.model_id,
        "input": text.strip(),
        "voice": voice_id.strip() or "alloy",
        "response_format": "pcm",
    }


def pcm_to_wav(pcm: bytes, sample_rate: int = 16000) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


def build_asr_multipart(endpoint: ModelEndpoint, wav_audio: bytes) -> tuple[bytes, str]:
    boundary = f"voice-route-{uuid.uuid4().hex}"
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{endpoint.model_id}\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode() + wav_audio + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _post(endpoint: ModelEndpoint, suffix: str, body: dict[str, Any], accept: str) -> bytes:
    request = Request(
        _endpoint_url(endpoint.base_url, suffix),
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {endpoint.api_key}", "Content-Type": "application/json", "Accept": accept},
        method="POST",
    )
    try:
        with urlopen(request, timeout=60) as response:
            return response.read()
    except HTTPError as exc:
        raise CascadeModelError(f"MODEL_HTTP_{exc.code}") from exc
    except (URLError, TimeoutError) as exc:
        raise CascadeModelError("MODEL_UNREACHABLE") from exc


def call_llm(endpoint: ModelEndpoint, candidate_text: str, context: dict[str, Any]) -> str:
    raw = _post(endpoint, "/chat/completions", build_llm_request(endpoint, candidate_text, context), "application/json")
    try:
        payload = json.loads(raw)
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise CascadeModelError("LLM_RESPONSE_INVALID") from exc
    if not isinstance(content, str) or not content.strip():
        raise CascadeModelError("LLM_RESPONSE_EMPTY")
    return content.strip()


def call_asr(endpoint: ModelEndpoint, pcm: bytes, sample_rate: int = 16000) -> str:
    body, content_type = build_asr_multipart(endpoint, pcm_to_wav(pcm, sample_rate))
    request = Request(
        _endpoint_url(endpoint.base_url, "/audio/transcriptions"),
        data=body,
        headers={"Authorization": f"Bearer {endpoint.api_key}", "Content-Type": content_type, "Accept": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=60) as response:
            payload = json.load(response)
    except HTTPError as exc:
        raise CascadeModelError(f"ASR_HTTP_{exc.code}") from exc
    except (URLError, TimeoutError) as exc:
        raise CascadeModelError("ASR_UNREACHABLE") from exc
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise CascadeModelError("ASR_RESPONSE_INVALID")
    return text.strip()


def call_tts(endpoint: ModelEndpoint, text: str, voice_id: str) -> bytes:
    pcm = _post(endpoint, "/audio/speech", build_tts_request(endpoint, text, voice_id), "application/octet-stream")
    if not pcm or len(pcm) % 2:
        raise CascadeModelError("TTS_PCM_INVALID")
    return pcm


def pcm_frames(pcm: bytes, *, sample_rate: int = 24000, frame_ms: int = 20) -> Iterator[bytes]:
    if not pcm or len(pcm) % 2:
        raise CascadeModelError("TTS_PCM_INVALID")
    frame_bytes = sample_rate * 2 * frame_ms // 1000
    for offset in range(0, len(pcm), frame_bytes):
        chunk = pcm[offset : offset + frame_bytes]
        if len(chunk) < frame_bytes:
            chunk += bytes(frame_bytes - len(chunk))
        yield chunk


async def run_cascade_turn(
    llm: ModelEndpoint,
    tts: ModelEndpoint,
    candidate_text: str,
    voice_id: str,
    context: dict[str, Any],
) -> tuple[str, bytes]:
    reply = await asyncio.to_thread(call_llm, llm, candidate_text, context)
    pcm = await asyncio.to_thread(call_tts, tts, reply, voice_id)
    return reply, pcm
