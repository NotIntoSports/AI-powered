import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli

from aliyun_nls import AliyunNlsConfig, AliyunNlsSession, AliyunTokenProvider, SAMPLE_RATE

TOPIC = "subtitle.v1"
logger = logging.getLogger("livekit-agent")

_cached_speech: dict | None = None
_cached_pipeline: dict | None = None
_cached_nls_config: AliyunNlsConfig | None = None


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


def load_agent_runtime() -> tuple[AliyunNlsConfig, dict]:
    global _cached_speech, _cached_pipeline, _cached_nls_config
    if _cached_nls_config is not None and _cached_pipeline is not None:
        return _cached_nls_config, _cached_pipeline

    origin = _agent_origin()
    token = _agent_token()
    if origin and token:
        speech = _fetch_agent_json("/api/v1/agent/settings/speech")
        pipeline = _fetch_agent_json("/api/v1/agent/settings/pipeline")
        logger.info(
            json.dumps(
                {
                    "event": "agent_settings_loaded",
                    "origin": origin,
                    "pipelineMode": pipeline.get("mode"),
                    "speechLanguage": speech.get("language"),
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
        pipeline = {"mode": "cascaded", "enabled": True}

    config = AliyunNlsConfig.from_dict(speech)
    _cached_speech = speech
    _cached_pipeline = pipeline
    _cached_nls_config = config
    return config, pipeline


def subtitle_packet(session_id: str, utterance_id: str, text: str, final: bool, language: str) -> bytes:
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
            "source": "livekit",
        },
        ensure_ascii=False,
    ).encode("utf-8")


async def publish_v1(room: rtc.Room, utterance_id: str, text: str, final: bool, language: str) -> None:
    if not text.strip():
        return
    await room.local_participant.publish_data(
        subtitle_packet(room.name, utterance_id, text.strip(), final, language),
        topic=TOPIC,
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


async def wait_for_shutdown(ctx: JobContext) -> None:
    done = asyncio.Event()

    async def on_shutdown(_reason: str) -> None:
        done.set()

    ctx.add_shutdown_callback(on_shutdown)
    await done.wait()


async def entrypoint(ctx: JobContext) -> None:
    config, pipeline = load_agent_runtime()
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    if pipeline.get("mode") == "e2e":
        logger.warning(
            json.dumps(
                {
                    "event": "E2E_NOT_IMPLEMENTED",
                    "room": ctx.room.name,
                    "e2eProvider": pipeline.get("e2eProvider"),
                },
                ensure_ascii=False,
            )
        )
        await wait_for_shutdown(ctx)
        return

    token_provider = AliyunTokenProvider(config)
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
                        "event": "asr_track_failed",
                        "provider": "aliyun_nls",
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
                {"event": "audio_track_subscribed", "provider": "aliyun_nls", "room": ctx.room.name}
            )
        )
        task = asyncio.create_task(transcribe_track(ctx.room, track, config, token_provider))
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
