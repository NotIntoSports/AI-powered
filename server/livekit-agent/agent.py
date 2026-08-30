import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli

from aliyun_nls import AliyunNlsConfig, AliyunNlsSession, AliyunTokenProvider, SAMPLE_RATE
from e2e_model import AudioTurnBuffer, E2EConfig, E2EModelError, call_e2e

SUBTITLE_TOPIC = "subtitle.v1"
RESPONSE_TOPIC = "agent.response.v1"
logger = logging.getLogger("livekit-agent")

_cached_speech: dict | None = None
_cached_pipeline: dict | None = None
_cached_ai: dict | None = None
_cached_nls_config: AliyunNlsConfig | None = None
_cached_e2e_config: E2EConfig | None = None


def _agent_origin() -> str:
    return os.environ.get("CONTROL_API_ORIGIN", "").strip().rstrip("/")


def _agent_token() -> str:
    return os.environ.get("AGENT_INTERNAL_TOKEN", "").strip()


def _fetch_agent_json(path: str) -> dict:
    origin = _agent_origin()
    token = _agent_token()
    if not origin or not token:
        raise RuntimeError("AGENT_CONTROL_API_UNCONFIGURED")
    request = Request(
        f"{origin}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=8) as response:
            payload = json.load(response)
    except HTTPError as exc:
        raise RuntimeError(f"AGENT_SETTINGS_HTTP_{exc.code}") from exc
    except URLError as exc:
        raise RuntimeError("AGENT_SETTINGS_UNREACHABLE") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("AGENT_SETTINGS_INVALID")
    return payload


def load_agent_runtime() -> tuple[AliyunNlsConfig | None, E2EConfig | None, dict]:
    global _cached_speech, _cached_pipeline, _cached_ai, _cached_nls_config, _cached_e2e_config
    if _cached_pipeline is not None:
        return _cached_nls_config, _cached_e2e_config, _cached_pipeline

    origin = _agent_origin()
    token = _agent_token()
    if origin and token:
        pipeline = _fetch_agent_json("/api/v1/agent/settings/pipeline")
        if pipeline.get("mode") == "e2e":
            ai = _fetch_agent_json("/api/v1/agent/settings/ai")
            speech = {}
            nls_config = None
            e2e_config = E2EConfig.from_dict(ai)
            _cached_speech = None
            _cached_ai = ai
            _cached_nls_config = None
            _cached_e2e_config = e2e_config
        else:
            speech = _fetch_agent_json("/api/v1/agent/settings/speech")
            ai = {}
            nls_config = AliyunNlsConfig.from_dict(speech)
            e2e_config = None
            _cached_speech = speech
            _cached_nls_config = nls_config
            _cached_e2e_config = None
            _cached_ai = None
        logger.info(
            json.dumps(
                {
                    "event": "agent_settings_loaded",
                    "origin": origin,
                    "pipelineMode": pipeline.get("mode"),
                    "speechLanguage": speech.get("language") or ai.get("language"),
                    "e2eModel": ai.get("model") if ai else None,
                },
                ensure_ascii=False,
            )
        )
    else:
        logger.warning(
            json.dumps(
                {
                    "event": "agent_settings_env_fallback",
                    "reason": "CONTROL_API_ORIGIN or AGENT_INTERNAL_TOKEN missing",
                },
                ensure_ascii=False,
            )
        )
        speech = {}
        ai = {}
        pipeline = {"mode": "cascaded", "enabled": True}
        nls_config = AliyunNlsConfig.from_dict(speech)
        e2e_config = None

    _cached_pipeline = pipeline
    if pipeline.get("mode") != "e2e":
        _cached_nls_config = nls_config
    return nls_config, e2e_config, pipeline


def subtitle_packet(session_id: str, utterance_id: str, text: str, final: bool, language: str, source: str = "livekit") -> bytes:
    return json.dumps(
        {
            "v": 1,
            "sessionId": session_id,
            "speaker": "candidate",
            "utteranceId": utterance_id,
            "text": text,
            "final": final,
            "language": language,
            "emittedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": source,
        },
        ensure_ascii=False,
    ).encode("utf-8")


def response_packet(
    session_id: str,
    utterance_id: str,
    candidate_text: str,
    reply_text: str,
    final: bool,
    language: str,
) -> bytes:
    return json.dumps(
        {
            "v": 1,
            "sessionId": session_id,
            "utteranceId": utterance_id,
            "candidateText": candidate_text,
            "replyText": reply_text,
            "final": final,
            "language": language,
            "emittedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": "livekit-e2e",
        },
        ensure_ascii=False,
    ).encode("utf-8")


async def publish_v1(
    room: rtc.Room,
    utterance_id: str,
    text: str,
    final: bool,
    language: str,
    *,
    source: str = "livekit",
) -> None:
    if not text.strip():
        return
    await room.local_participant.publish_data(
        subtitle_packet(room.name, utterance_id, text.strip(), final, language, source),
        topic=SUBTITLE_TOPIC,
    )
    if final:
        logger.info(
            json.dumps(
                {
                    "event": "subtitle_published",
                    "provider": "aliyun_nls",
                    "room": room.name,
                    "utterance_id": utterance_id,
                    "final": True,
                    "characters": len(text.strip()),
                },
                ensure_ascii=False,
            )
        )


async def publish_response(
    room: rtc.Room,
    utterance_id: str,
    candidate_text: str,
    reply_text: str,
    final: bool,
    language: str,
) -> None:
    if not candidate_text.strip() or not reply_text.strip():
        return
    await room.local_participant.publish_data(
        response_packet(room.name, utterance_id, candidate_text.strip(), reply_text.strip(), final, language),
        topic=RESPONSE_TOPIC,
    )
    if final:
        logger.info(
            json.dumps(
                {
                    "event": "agent_response_published",
                    "provider": "e2e",
                    "room": room.name,
                    "utterance_id": utterance_id,
                    "candidateCharacters": len(candidate_text.strip()),
                    "replyCharacters": len(reply_text.strip()),
                },
                ensure_ascii=False,
            )
        )


async def transcribe_track(
    room: rtc.Room,
    track: rtc.Track,
    config: AliyunNlsConfig,
    token_provider: AliyunTokenProvider,
) -> None:
    audio_stream = rtc.AudioStream(
        track,
        sample_rate=SAMPLE_RATE,
        num_channels=1,
        frame_size_ms=20,
    )
    session = AliyunNlsSession(config, token_provider)
    try:
        await session.connect()
        logger.info(
            json.dumps(
                {"event": "asr_connected", "provider": "aliyun_nls", "room": room.name},
                ensure_ascii=False,
            )
        )

        async def pump_audio() -> None:
            try:
                async for frame in audio_stream:
                    await session.send_audio(bytes(frame.frame.data))
            finally:
                await session.stop()

        async def pump_events() -> None:
            async for transcript in session.results():
                await publish_v1(
                    room,
                    transcript.utterance_id,
                    transcript.text,
                    transcript.final,
                    config.language,
                )

        async with asyncio.TaskGroup() as group:
            group.create_task(pump_audio())
            group.create_task(pump_events())
    finally:
        await session.close()


async def e2e_track(room: rtc.Room, track: rtc.Track, config: E2EConfig) -> None:
    audio_stream = rtc.AudioStream(
        track,
        sample_rate=SAMPLE_RATE,
        num_channels=1,
        frame_size_ms=20,
    )
    buffer = AudioTurnBuffer()
    logger.info(
        json.dumps(
            {"event": "e2e_connected", "provider": "tokenplan", "room": room.name, "model": config.model},
            ensure_ascii=False,
        )
    )
    try:
        async for frame in audio_stream:
            pcm = bytes(frame.frame.data)
            chunk = buffer.push(pcm)
            if chunk is None:
                continue
            utterance_id = str(uuid.uuid4())
            try:
                result = await asyncio.to_thread(call_e2e, config, chunk, utterance_id)
            except E2EModelError as exc:
                logger.error(
                    json.dumps(
                        {
                            "event": "e2e_turn_failed",
                            "room": room.name,
                            "errorType": type(exc).__name__,
                            "error": str(exc),
                        },
                        ensure_ascii=False,
                    )
                )
                continue
            await publish_v1(room, result.utterance_id, result.transcript, True, config.language, source="livekit-e2e")
            await publish_response(
                room,
                result.utterance_id,
                result.transcript,
                result.reply,
                True,
                config.language,
            )
    finally:
        buffer.reset()


async def wait_for_shutdown(ctx: JobContext) -> None:
    done = asyncio.Event()

    async def on_shutdown(_reason: str) -> None:
        done.set()

    ctx.add_shutdown_callback(on_shutdown)
    await done.wait()


async def entrypoint(ctx: JobContext) -> None:
    nls_config, e2e_config, pipeline = load_agent_runtime()
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    e2e_mode = pipeline.get("mode") == "e2e"
    if e2e_mode and e2e_config is None:
        logger.error(
            json.dumps(
                {"event": "E2E_CONFIG_MISSING", "room": ctx.room.name, "e2eProvider": pipeline.get("e2eProvider")},
                ensure_ascii=False,
            )
        )
        await wait_for_shutdown(ctx)
        return

    token_provider = AliyunTokenProvider(nls_config) if nls_config else None
    tasks: set[asyncio.Task] = set()

    def finish_task(task: asyncio.Task) -> None:
        tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.error(
                json.dumps(
                    {
                        "event": "audio_track_failed",
                        "provider": "e2e" if e2e_mode else "aliyun_nls",
                        "room": ctx.room.name,
                        "errorType": type(error).__name__,
                    }
                )
            )

    def start_track(track: rtc.Track) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        logger.info(
            json.dumps(
                {
                    "event": "audio_track_subscribed",
                    "provider": "e2e" if e2e_mode else "aliyun_nls",
                    "room": ctx.room.name,
                }
            )
        )
        if e2e_mode and e2e_config is not None:
            task = asyncio.create_task(e2e_track(ctx.room, track, e2e_config))
        elif nls_config is not None and token_provider is not None:
            task = asyncio.create_task(transcribe_track(ctx.room, track, nls_config, token_provider))
        else:
            return
        tasks.add(task)
        task.add_done_callback(finish_task)

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(track: rtc.Track, _publication, _participant) -> None:
        start_track(track)

    for participant in ctx.room.remote_participants.values():
        for publication in participant.track_publications.values():
            if publication.track:
                start_track(publication.track)

    await wait_for_shutdown(ctx)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
    load_agent_runtime()
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
