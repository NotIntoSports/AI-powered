import asyncio
import json
import os
from datetime import datetime, timezone

from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli, stt
from livekit.plugins import openai

TOPIC = "subtitle.v1"


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


def utterance_id_for(event: stt.SpeechEvent, fallback: str) -> str:
    request_id = getattr(event, "request_id", None) or getattr(event, "id", None)
    if request_id:
        return str(request_id)
    return fallback


async def transcribe_track(room: rtc.Room, track: rtc.Track, recognizer: stt.STT) -> None:
    audio_stream = rtc.AudioStream(track)
    stt_stream = recognizer.stream()
    fallback_id = "utt_0"

    async def pump_audio() -> None:
        try:
            async for frame in audio_stream:
                stt_stream.push_frame(frame.frame)
        finally:
            stt_stream.end_input()

    async def pump_events() -> None:
        nonlocal fallback_id
        index = 0
        async for event in stt_stream:
            if event.type == stt.SpeechEventType.START_OF_SPEECH:
                index += 1
                fallback_id = f"utt_{index}"
                continue
            if event.type not in (
                stt.SpeechEventType.INTERIM_TRANSCRIPT,
                stt.SpeechEventType.FINAL_TRANSCRIPT,
            ):
                continue
            text = event.alternatives[0].text if event.alternatives else ""
            await publish_v1(
                room,
                utterance_id_for(event, fallback_id),
                text,
                event.type == stt.SpeechEventType.FINAL_TRANSCRIPT,
            )

    await asyncio.gather(pump_audio(), pump_events())


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    stt_key = os.environ.get("STT_API_KEY", "").strip()
    stt_base = os.environ.get("STT_BASE_URL", "").strip() or None
    stt_model = os.environ.get("STT_MODEL", "whisper-1").strip() or "whisper-1"
    recognizer = None
    if stt_key:
        recognizer = openai.STT(model=stt_model, api_key=stt_key, base_url=stt_base)

    tasks: set[asyncio.Task] = set()

    def start_track(track: rtc.Track) -> None:
        if recognizer is None or track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        task = asyncio.create_task(transcribe_track(ctx.room, track, recognizer))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

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


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
