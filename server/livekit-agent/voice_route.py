from dataclasses import dataclass

from e2e_model import E2EConfig


class VoiceRouteError(RuntimeError):
    pass


@dataclass(frozen=True)
class ModelEndpoint:
    provider_id: str
    model_id: str
    base_url: str
    api_key: str
    source: str

    @classmethod
    def from_dict(cls, payload: dict | None) -> "ModelEndpoint":
        data = payload or {}
        return cls(
            provider_id=str(data.get("providerId") or "").strip(),
            model_id=str(data.get("modelId") or "").strip(),
            base_url=str(data.get("baseUrl") or "").strip().rstrip("/"),
            api_key=str(data.get("apiKey") or "").strip(),
            source=str(data.get("source") or "").strip(),
        )

    def valid(self) -> bool:
        return bool(self.provider_id and self.model_id and (self.source == "speech" or (self.base_url and self.api_key)))


@dataclass(frozen=True)
class VoiceRouteRuntime:
    route_id: str
    version: int
    mode: str
    voice_id: str
    asr: ModelEndpoint | None = None
    llm: ModelEndpoint | None = None
    tts: ModelEndpoint | None = None
    e2e: E2EConfig | None = None
    speech: dict | None = None


def parse_voice_route(payload: dict) -> VoiceRouteRuntime:
    if not payload.get("active") or not payload.get("ready"):
        raise VoiceRouteError("VOICE_ROUTE_NOT_READY")
    route_id = str(payload.get("id") or "").strip()
    mode = str(payload.get("mode") or "").strip()
    if not route_id or mode not in {"cascaded", "e2e"}:
        raise VoiceRouteError("VOICE_ROUTE_NOT_READY")
    if mode == "e2e":
        endpoint = ModelEndpoint.from_dict(payload.get("e2e"))
        if not endpoint.valid():
            raise VoiceRouteError("VOICE_ROUTE_NOT_READY")
        try:
            e2e = E2EConfig.from_dict({"baseUrl": endpoint.base_url, "model": endpoint.model_id, "apiKey": endpoint.api_key, "language": payload.get("language") or "zh"})
        except RuntimeError as exc:
            raise VoiceRouteError("VOICE_ROUTE_NOT_READY") from exc
        return VoiceRouteRuntime(route_id, int(payload.get("configVersion") or 1), mode, str(payload.get("voiceId") or ""), e2e=e2e)
    asr = ModelEndpoint.from_dict(payload.get("asr"))
    llm = ModelEndpoint.from_dict(payload.get("llm"))
    tts = ModelEndpoint.from_dict(payload.get("tts"))
    if not all(endpoint.valid() for endpoint in (asr, llm, tts)):
        raise VoiceRouteError("VOICE_ROUTE_NOT_READY")
    return VoiceRouteRuntime(route_id, int(payload.get("configVersion") or 1), mode, str(payload.get("voiceId") or ""), asr=asr, llm=llm, tts=tts, speech=payload.get("speech"))
