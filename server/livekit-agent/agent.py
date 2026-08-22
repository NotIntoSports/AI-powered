import asyncio
import json
import logging
import os
from datetime import datetime, timezone

from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli

from aliyun_nls import AliyunNlsConfig, AliyunNlsSession, AliyunTokenProvider, SAMPLE_RATE

TOPIC = "subtitle.v1"
logger = logging.getLogger("livekit-agent")


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


async def publish_v1(room: rtc.Room, utterance_id: str, text: str, final: bool) -> None:
    if not text.strip():
        return
    language = os.environ.get("STT_LANGUAGE", "zh")
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
                )

        async with asyncio.TaskGroup() as group:
            group.create_task(pump_audio())
            group.create_task(pump_events())
    finally:
        await session.close()


async def entrypoint(ctx: JobContext) -> None:
    config = AliyunNlsConfig.from_env()
    token_provider = AliyunTokenProvider(config)
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

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

    done = asyncio.Event()

    async def on_shutdown(_reason: str) -> None:
        done.set()

    ctx.add_shutdown_callback(on_shutdown)
    await done.wait()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
    AliyunNlsConfig.from_env()
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
