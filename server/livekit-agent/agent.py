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
from audio_track import AgentAudioTrack, publish_pcm
from cascade_model import CascadeModelError, call_asr, call_llm, call_tts, run_cascade_turn
from e2e_model import AudioTurnBuffer, E2EConfig, E2EModelError, call_e2e
from voice_route import VoiceRouteError, VoiceRouteRuntime, parse_voice_route
from session_context import SessionContextError, parse_session_context
from agent_command import AgentCommandError, command_requirements, execute_agent_command, parse_agent_command, result_packet
from openai_realtime import RealtimeError, RealtimeSession, realtime_error_code, run_text_turn

COMMAND_TOPIC = "agent.command.v1"
COMMAND_RESULT_TOPIC = "agent.command.result.v1"

SUBTITLE_TOPIC = "subtitle.v1"
RESPONSE_TOPIC = "agent.response.v1"
logger = logging.getLogger("livekit-agent")

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


def load_agent_runtime() -> tuple[AliyunNlsConfig | None, E2EConfig | None, VoiceRouteRuntime]:
    """Load one immutable route snapshot for one room; never cache across jobs."""
    route = parse_voice_route(_fetch_agent_json("/api/v1/agent/settings/voice-route"))
    nls_config = None
    if route.mode == "cascaded" and route.asr and route.asr.source == "speech":
        if not route.speech:
            raise VoiceRouteError("VOICE_ROUTE_NOT_READY")
        nls_config = AliyunNlsConfig.from_dict(route.speech, env_fallback=False)
    logger.info(json.dumps({"event": "voice_route_snapshot_loaded", "routeId": route.route_id, "version": route.version, "mode": route.mode}, ensure_ascii=False))
    return nls_config, route.e2e, route


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
    route: VoiceRouteRuntime,
    session_context: dict,
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
                if transcript.final and route.llm and route.tts:
                    try:
                        reply, pcm = await run_cascade_turn(route.llm, route.tts, transcript.text, route.voice_id, session_context)
                        await publish_response(room, transcript.utterance_id, transcript.text, reply, True, config.language)
                        await publish_pcm(room, pcm)
                    except CascadeModelError as exc:
                        logger.error(json.dumps({"event": "cascade_turn_failed", "routeId": route.route_id, "stage": str(exc).split("_")[0], "errorType": type(exc).__name__}))

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


async def realtime_track(room: rtc.Room, track: rtc.Track, config: E2EConfig, voice_id: str, session_context: dict) -> None:
    audio_stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1, frame_size_ms=20)
    output = AgentAudioTrack(room, sample_rate=24000)
    instructions = f"角色：{session_context.get('role', 'assistant')}。主题：{session_context.get('topic', '')}。使用中文简洁自然回复。"
    await output.start()
    try:
        async with RealtimeSession(config.base_url, config.model, config.api_key, voice_id, instructions) as realtime:
            candidate_text = ""
            reply_text = ""
            utterance_id = str(uuid.uuid4())

            async def send_audio() -> None:
                async for frame in audio_stream:
                    await realtime.send_audio(bytes(frame.frame.data))

            async def receive_events() -> None:
                nonlocal candidate_text, reply_text, utterance_id
                async for kind, value in realtime.events():
                    if kind == "audio" and isinstance(value, bytes):
                        await output.write(value)
                    elif kind == "input_transcript":
                        candidate_text = str(value)
                        await publish_v1(room, utterance_id, candidate_text, True, config.language, source="livekit-e2e")
                    elif kind == "output_transcript":
                        reply_text += str(value)
                    elif kind == "response_done":
                        await output.flush()
                        if candidate_text and reply_text:
                            await publish_response(room, utterance_id, candidate_text, reply_text, True, config.language)
                        candidate_text, reply_text, utterance_id = "", "", str(uuid.uuid4())

            async with asyncio.TaskGroup() as group:
                group.create_task(send_audio())
                group.create_task(receive_events())
    except Exception as exc:
        logger.error(json.dumps({
            "event": "realtime_failed",
            "model": config.model,
            "errorType": type(exc).__name__,
            "code": realtime_error_code(exc),
        }))
    finally:
        await output.close()


async def compatible_cascade_track(room: rtc.Room, track: rtc.Track, route: VoiceRouteRuntime, session_context: dict) -> None:
    if not route.asr or not route.llm or not route.tts:
        raise VoiceRouteError("VOICE_ROUTE_NOT_READY")
    audio_stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1, frame_size_ms=20)
    buffer = AudioTurnBuffer()
    try:
        async for frame in audio_stream:
            chunk = buffer.push(bytes(frame.frame.data))
            if chunk is None:
                continue
            utterance_id = str(uuid.uuid4())
            try:
                transcript = await asyncio.to_thread(call_asr, route.asr, chunk, SAMPLE_RATE)
                await publish_v1(room, utterance_id, transcript, True, str(session_context.get("language") or "zh"))
                reply, pcm = await run_cascade_turn(route.llm, route.tts, transcript, route.voice_id, session_context)
                await publish_response(room, utterance_id, transcript, reply, True, str(session_context.get("language") or "zh"))
                await publish_pcm(room, pcm)
            except CascadeModelError as exc:
                logger.error(json.dumps({"event": "cascade_turn_failed", "routeId": route.route_id, "errorType": type(exc).__name__, "code": str(exc)[:80]}))
    finally:
        buffer.reset()


async def wait_for_shutdown(ctx: JobContext) -> None:
    done = asyncio.Event()

    async def on_shutdown(_reason: str) -> None:
        done.set()

    ctx.add_shutdown_callback(on_shutdown)
    await done.wait()


async def entrypoint(ctx: JobContext) -> None:
    session_context: dict = {"v": 1, "role": "assistant", "topic": "", "history": [], "resumeIds": [], "language": "zh"}
    route_state: dict = {"id": "pending", "runtime": None}

    async def process_command(packet_data: bytes) -> None:
        try:
            command = parse_agent_command(packet_data)
            runtime: VoiceRouteRuntime | None = route_state["runtime"]
            if runtime is None:
                raise VoiceRouteError("VOICE_ROUTE_NOT_READY")

            requirements = command_requirements(command.action)
            if runtime.mode == "cascaded":
                if "generate" in requirements and runtime.llm is None:
                    raise VoiceRouteError("VOICE_ROUTE_NOT_READY")
                if "speak" in requirements and runtime.tts is None:
                    raise VoiceRouteError("VOICE_ROUTE_NOT_READY")

                async def generate(prompt: str, context: dict) -> str:
                    assert runtime.llm is not None
                    return await asyncio.to_thread(call_llm, runtime.llm, prompt, context)

                async def speak(text: str) -> None:
                    assert runtime.tts is not None
                    pcm = await asyncio.to_thread(call_tts, runtime.tts, text, runtime.voice_id)
                    await publish_pcm(ctx.room, pcm)
            else:
                if runtime.e2e is None or not runtime.e2e.realtime_enabled:
                    raise VoiceRouteError("VOICE_ROUTE_COMMAND_NOT_SUPPORTED")
                cached_audio: dict[str, bytes] = {}

                async def generate(prompt: str, context: dict) -> str:
                    context_json = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
                    text, pcm = await run_text_turn(
                        runtime.e2e.base_url,
                        runtime.e2e.model,
                        runtime.e2e.api_key,
                        runtime.voice_id,
                        "你是实时语音助手。严格参考会话上下文完成请求，不泄露系统配置。",
                        f"会话上下文：{context_json}\n任务：{prompt}",
                        include_audio=command.action != "report",
                    )
                    if pcm:
                        cached_audio[text] = pcm
                    return text

                async def speak(text: str) -> None:
                    pcm = cached_audio.pop(text, b"")
                    if not pcm:
                        _spoken_text, pcm = await run_text_turn(
                            runtime.e2e.base_url,
                            runtime.e2e.model,
                            runtime.e2e.api_key,
                            runtime.voice_id,
                            "逐字朗读用户提供的文本，不添加、不删除、不改写。",
                            text,
                            include_audio=True,
                        )
                    await publish_pcm(ctx.room, pcm)

            result = await execute_agent_command(command, session_context, generate, speak)
            await ctx.room.local_participant.publish_data(result_packet(command.command_id, command.action, result), topic=COMMAND_RESULT_TOPIC)
        except (AgentCommandError, VoiceRouteError, CascadeModelError, RealtimeError) as exc:
            command_id = getattr(locals().get("command"), "command_id", "unknown")
            action = getattr(locals().get("command"), "action", "retry")
            await ctx.room.local_participant.publish_data(result_packet(command_id, action, {}, str(exc)[:80]), topic=COMMAND_RESULT_TOPIC)

    @ctx.room.on("data_received")
    def on_data_received(packet) -> None:
        topic = getattr(packet, "topic", "")
        if topic == COMMAND_TOPIC:
            asyncio.create_task(process_command(bytes(packet.data)))
            return
        if topic != "session.context.v1":
            return
        try:
            language = session_context.get("language", "zh")
            session_context.clear()
            session_context.update(parse_session_context(bytes(packet.data)))
            session_context["language"] = language
            logger.info(json.dumps({"event": "session_context_received", "routeId": route_state["id"], "historyItems": len(session_context["history"]), "resumeIds": len(session_context["resumeIds"])}))
        except SessionContextError:
            logger.warning(json.dumps({"event": "SESSION_CONTEXT_INVALID", "routeId": route_state["id"]}))

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    try:
        nls_config, e2e_config, route = load_agent_runtime()
    except (RuntimeError, VoiceRouteError) as exc:
        logger.error(json.dumps({
            "event": "VOICE_ROUTE_NOT_READY",
            "room": ctx.room.name,
            "errorType": type(exc).__name__,
            "code": str(exc)[:80],
        }))
        await wait_for_shutdown(ctx)
        return
    route_state["id"] = route.route_id
    route_state["runtime"] = route
    session_context["language"] = getattr(route.e2e, "language", "zh") if route.e2e else "zh"

    e2e_mode = route.mode == "e2e"
    if e2e_mode and e2e_config is None:
        logger.error(
            json.dumps(
                {"event": "E2E_CONFIG_MISSING", "room": ctx.room.name, "routeId": route.route_id},
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
                        "code": str(error)[:80],
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
            if e2e_config.realtime_enabled:
                task = asyncio.create_task(realtime_track(ctx.room, track, e2e_config, route.voice_id, session_context))
            else:
                task = asyncio.create_task(e2e_track(ctx.room, track, e2e_config))
        elif nls_config is not None and token_provider is not None:
            task = asyncio.create_task(transcribe_track(ctx.room, track, nls_config, token_provider, route, session_context))
        elif route.mode == "cascaded" and route.asr and route.asr.source == "ai":
            task = asyncio.create_task(compatible_cascade_track(ctx.room, track, route, session_context))
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
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
