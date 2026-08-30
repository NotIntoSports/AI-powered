import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import AsyncIterator
from urllib.parse import quote
from urllib.request import Request, urlopen

from websockets.asyncio.client import ClientConnection, connect

DEFAULT_GATEWAY = "https://nls-gateway-cn-shanghai.aliyuncs.com"
TOKEN_ENDPOINT = "https://nls-meta.cn-shanghai.aliyuncs.com/"
SAMPLE_RATE = 16_000


class AliyunNlsError(RuntimeError):
    pass


def _coalesce_str(*values: object) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _coalesce_bool(value: object, default: bool) -> bool:
    return default if not isinstance(value, bool) else value


def _coalesce_int(value: object, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return default


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


@dataclass(frozen=True)
class AliyunNlsConfig:
    app_key: str
    access_key_id: str = ""
    access_key_secret: str = ""
    token: str = ""
    gateway: str = DEFAULT_GATEWAY
    language: str = "zh"
    customization_id: str = ""
    vocabulary_id: str = ""
    enable_intermediate_result: bool = True
    enable_punctuation_prediction: bool = True
    enable_inverse_text_normalization: bool = True
    enable_disfluency: bool = False
    enable_semantic_sentence_detection: bool = False
    max_sentence_silence: int = 800
    enable_voice_detection: bool = False
    max_start_silence: int | None = None
    max_end_silence: int | None = None

    @classmethod
    def from_env(cls) -> "AliyunNlsConfig":
        return cls.from_dict({}, env_fallback=True)

    @classmethod
    def from_dict(cls, data: dict | None, *, env_fallback: bool = True) -> "AliyunNlsConfig":
        payload = data or {}
        config = cls(
            app_key=_coalesce_str(payload.get("aliyunAppKey"), payload.get("appKey"))
            or (os.environ.get("ALIYUN_NLS_APPKEY", "").strip() if env_fallback else ""),
            access_key_id=_coalesce_str(payload.get("aliyunAccessKeyId"), payload.get("accessKeyId"))
            or (
                (
                    os.environ.get("ALIYUN_NLS_ACCESS_KEY_ID", "")
                    or os.environ.get("ALIYUN_AK_ID", "")
                ).strip()
                if env_fallback
                else ""
            ),
            access_key_secret=_coalesce_str(
                payload.get("aliyunAccessKeySecret"), payload.get("accessKeySecret")
            )
            or (
                (
                    os.environ.get("ALIYUN_NLS_ACCESS_KEY_SECRET", "")
                    or os.environ.get("ALIYUN_AK_SECRET", "")
                ).strip()
                if env_fallback
                else ""
            ),
            token=_coalesce_str(payload.get("aliyunToken"), payload.get("token"))
            or (os.environ.get("ALIYUN_NLS_TOKEN", "").strip() if env_fallback else ""),
            gateway=_coalesce_str(payload.get("aliyunGateway"), payload.get("gateway"))
            or (
                (os.environ.get("ALIYUN_NLS_GATEWAY", "") or DEFAULT_GATEWAY).strip()
                if env_fallback
                else DEFAULT_GATEWAY
            ),
            language=_coalesce_str(payload.get("language"))
            or (
                (os.environ.get("STT_LANGUAGE", "") or "zh").strip()
                if env_fallback
                else "zh"
            ),
            customization_id=_coalesce_str(
                payload.get("aliyunAsrCustomizationId"), payload.get("customizationId")
            ),
            vocabulary_id=_coalesce_str(
                payload.get("aliyunAsrVocabularyId"), payload.get("vocabularyId")
            ),
            enable_intermediate_result=_coalesce_bool(
                payload.get("aliyunAsrEnableIntermediate"), True
            ),
            enable_punctuation_prediction=_coalesce_bool(payload.get("aliyunAsrEnablePunc"), True),
            enable_inverse_text_normalization=_coalesce_bool(payload.get("aliyunAsrEnableItn"), True),
            enable_disfluency=_coalesce_bool(payload.get("aliyunAsrEnableDisfluency"), False),
            enable_semantic_sentence_detection=_coalesce_bool(
                payload.get("aliyunAsrEnableSemanticBreak"), False
            ),
            max_sentence_silence=_coalesce_int(payload.get("aliyunAsrMaxSentenceSilence"), 800),
            enable_voice_detection=_coalesce_bool(
                payload.get("aliyunAsrEnableVoiceDetection"), False
            ),
            max_start_silence=_optional_int(payload.get("aliyunAsrMaxStartSilence")),
            max_end_silence=_optional_int(payload.get("aliyunAsrMaxEndSilence")),
        )
        if not config.app_key:
            raise AliyunNlsError("ALIYUN_NLS_APPKEY_MISSING")
        if not config.token and not (config.access_key_id and config.access_key_secret):
            raise AliyunNlsError("ALIYUN_NLS_CREDENTIALS_MISSING")
        return config

    def start_transcription_payload(self) -> dict:
        payload: dict = {
            "format": "pcm",
            "sample_rate": SAMPLE_RATE,
            "enable_intermediate_result": self.enable_intermediate_result,
            "enable_punctuation_prediction": self.enable_punctuation_prediction,
            "enable_inverse_text_normalization": self.enable_inverse_text_normalization,
        }
        if self.customization_id:
            payload["customization_id"] = self.customization_id
        if self.vocabulary_id:
            payload["vocabulary_id"] = self.vocabulary_id
        if self.enable_disfluency:
            payload["enable_disfluency"] = True
        if self.enable_semantic_sentence_detection:
            payload["enable_semantic_sentence_detection"] = True
        if self.max_sentence_silence > 0:
            payload["max_sentence_silence"] = self.max_sentence_silence
        if self.enable_voice_detection:
            payload["enable_voice_detection"] = True
        if self.max_start_silence is not None:
            payload["max_start_silence"] = self.max_start_silence
        if self.max_end_silence is not None:
            payload["max_end_silence"] = self.max_end_silence
        return payload

    @property
    def websocket_url(self) -> str:
        gateway = self.gateway.rstrip("/")
        if gateway.startswith("https://"):
            gateway = "wss://" + gateway.removeprefix("https://")
        elif gateway.startswith("http://"):
            gateway = "ws://" + gateway.removeprefix("http://")
        if not gateway.startswith(("ws://", "wss://")):
            raise AliyunNlsError("ALIYUN_NLS_GATEWAY_INVALID")
        return gateway if gateway.endswith("/ws/v1") else gateway + "/ws/v1"


@dataclass(frozen=True)
class Transcript:
    utterance_id: str
    text: str
    final: bool


def _percent_encode(value: str) -> str:
    return quote(value, safe="~-._")


def build_create_token_url(
    access_key_id: str,
    access_key_secret: str,
    timestamp: str,
    nonce: str,
) -> str:
    params = {
        "AccessKeyId": access_key_id,
        "Action": "CreateToken",
        "Format": "JSON",
        "RegionId": "cn-shanghai",
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": nonce,
        "SignatureVersion": "1.0",
        "Timestamp": timestamp,
        "Version": "2019-02-28",
    }
    query = "&".join(
        f"{_percent_encode(key)}={_percent_encode(params[key])}" for key in sorted(params)
    )
    string_to_sign = f"GET&{_percent_encode('/')}&{_percent_encode(query)}"
    digest = hmac.new(
        f"{access_key_secret}&".encode(), string_to_sign.encode(), hashlib.sha1
    ).digest()
    signature = base64.b64encode(digest).decode()
    return f"{TOKEN_ENDPOINT}?{query}&Signature={_percent_encode(signature)}"


def _request_token(config: AliyunNlsConfig) -> tuple[str, int]:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = build_create_token_url(
        config.access_key_id,
        config.access_key_secret,
        timestamp,
        str(uuid.uuid4()),
    )
    request = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=8) as response:
            payload = json.load(response)
    except Exception as exc:
        raise AliyunNlsError("ALIYUN_NLS_TOKEN_REQUEST_FAILED") from exc
    token = payload.get("Token") if isinstance(payload, dict) else None
    token_id = str(token.get("Id", "")).strip() if isinstance(token, dict) else ""
    expire_time = int(token.get("ExpireTime", 0)) if isinstance(token, dict) else 0
    if not token_id or expire_time <= 0:
        raise AliyunNlsError("ALIYUN_NLS_TOKEN_INVALID")
    return token_id, expire_time


class AliyunTokenProvider:
    def __init__(self, config: AliyunNlsConfig):
        self._config = config
        self._cached: tuple[str, int] | None = None
        self._lock = asyncio.Lock()

    async def get(self) -> str:
        if self._config.token:
            return self._config.token
        async with self._lock:
            if self._cached and self._cached[1] - 300 > int(time.time()):
                return self._cached[0]
            self._cached = await asyncio.to_thread(_request_token, self._config)
            return self._cached[0]


class AliyunNlsSession:
    def __init__(self, config: AliyunNlsConfig, token_provider: AliyunTokenProvider):
        self._config = config
        self._token_provider = token_provider
        self._task_id = uuid.uuid4().hex
        self._socket: ClientConnection | None = None
        self._stopped = False

    def _command(self, name: str, payload: dict | None = None) -> str:
        message: dict = {
            "header": {
                "message_id": uuid.uuid4().hex,
                "task_id": self._task_id,
                "namespace": "SpeechTranscriber",
                "name": name,
                "appkey": self._config.app_key,
            },
            "context": {
                "sdk": {
                    "name": "ai-powered-livekit-agent",
                    "version": "1.0.0",
                    "language": "python",
                }
            },
        }
        if payload is not None:
            message["payload"] = payload
        return json.dumps(message, ensure_ascii=False)

    async def connect(self) -> None:
        token = await self._token_provider.get()
        self._socket = await connect(
            self._config.websocket_url,
            additional_headers={"X-NLS-Token": token},
            ping_interval=8,
            ping_timeout=20,
            open_timeout=10,
            close_timeout=5,
            max_size=1 << 20,
        )
        await self._socket.send(
            self._command("StartTranscription", self._config.start_transcription_payload())
        )
        while True:
            message = await asyncio.wait_for(self._socket.recv(), timeout=10)
            event = self._decode_event(message)
            name = event["header"].get("name")
            if name == "TranscriptionStarted":
                return
            if name == "TaskFailed":
                raise self._task_error(event)

    async def send_audio(self, audio: bytes) -> None:
        if self._socket is None:
            raise AliyunNlsError("ALIYUN_NLS_NOT_CONNECTED")
        if audio:
            await self._socket.send(audio)

    async def stop(self) -> None:
        if self._socket is None or self._stopped:
            return
        self._stopped = True
        await self._socket.send(self._command("StopTranscription"))

    async def results(self) -> AsyncIterator[Transcript]:
        if self._socket is None:
            raise AliyunNlsError("ALIYUN_NLS_NOT_CONNECTED")
        async for message in self._socket:
            event = self._decode_event(message)
            header = event["header"]
            payload = event.get("payload") or {}
            name = header.get("name")
            if name == "TaskFailed":
                raise self._task_error(event)
            if name == "TranscriptionCompleted":
                return
            if name not in ("TranscriptionResultChanged", "SentenceEnd"):
                continue
            text = str(payload.get("result", "")).strip()
            if not text:
                continue
            sentence_index = payload.get("index", payload.get("sentence_id", "0"))
            yield Transcript(
                utterance_id=f"{self._task_id}_{sentence_index}",
                text=text,
                final=name == "SentenceEnd",
            )

    async def close(self) -> None:
        if self._socket is not None:
            await self._socket.close()
            self._socket = None

    @staticmethod
    def _decode_event(message: str | bytes) -> dict:
        if isinstance(message, bytes):
            raise AliyunNlsError("ALIYUN_NLS_UNEXPECTED_BINARY_EVENT")
        try:
            event = json.loads(message)
        except json.JSONDecodeError as exc:
            raise AliyunNlsError("ALIYUN_NLS_INVALID_EVENT") from exc
        if not isinstance(event, dict) or not isinstance(event.get("header"), dict):
            raise AliyunNlsError("ALIYUN_NLS_INVALID_EVENT")
        return event

    @staticmethod
    def _task_error(event: dict) -> AliyunNlsError:
        header = event.get("header") or {}
        status = str(header.get("status", "unknown"))[:32]
        return AliyunNlsError(f"ALIYUN_NLS_TASK_FAILED:{status}")
