import asyncio
import base64
import json
import unittest
from pathlib import Path

import openai_realtime
from openai_realtime import (
    InputTranscriptAssembler,
    RealtimeError,
    RealtimeSession,
    append_audio_event,
    conversation_text_event,
    parse_server_event,
    realtime_dialect,
    realtime_error_code,
    realtime_log_fields,
    realtime_url,
    response_create_event,
    session_update_event,
)


class OpenAIRealtimeTests(unittest.TestCase):
    def test_input_transcript_assembler_streams_snapshots_and_deltas_per_item(self):
        assembler = InputTranscriptAssembler()
        self.assertEqual(
            assembler.update("input_transcript_delta", {
                "item_id": "qwen-1", "text": "今天", "stash": "天气", "delta": ""
            }),
            ("qwen-1", "今天天气", False),
        )
        self.assertEqual(
            assembler.update("input_transcript_delta", {
                "item_id": "openai-1", "text": "", "stash": "", "delta": "你"
            }),
            ("openai-1", "你", False),
        )
        self.assertEqual(
            assembler.update("input_transcript_delta", {
                "item_id": "openai-1", "text": "", "stash": "", "delta": "好"
            }),
            ("openai-1", "你好", False),
        )
        self.assertEqual(
            assembler.update("input_transcript_completed", {
                "item_id": "openai-1", "transcript": "你好。"
            }),
            ("openai-1", "你好。", True),
        )

    def test_input_transcript_assembler_ignores_late_partial_after_final(self):
        assembler = InputTranscriptAssembler()
        assembler.update("input_transcript_completed", {"item_id": "item-1", "transcript": "最终"})
        self.assertIsNone(assembler.update("input_transcript_delta", {
            "item_id": "item-1", "text": "旧", "stash": "", "delta": ""
        }))

    def test_openai_v1_uses_realtime_endpoint_and_pcm16(self):
        dialect = realtime_dialect("https://api.openai.com/v1")
        self.assertEqual(
            realtime_url("https://api.openai.com/v1", "gpt-4o-realtime-preview"),
            "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
        )
        self.assertEqual(dialect.audio_format, "pcm16")
        self.assertEqual(dialect.default_voice, "alloy")

    def test_custom_openai_v1_keeps_path_prefix(self):
        self.assertEqual(
            realtime_url("https://gateway.example/openai/v1", "custom-realtime"),
            "wss://gateway.example/openai/v1/realtime?model=custom-realtime",
        )

    def test_token_plan_uses_aliyun_dialect(self):
        dialect = realtime_dialect("https://token-plan.cn-beijing.maas.aliyuncs.com/v1")
        self.assertEqual(
            realtime_url("https://token-plan.cn-beijing.maas.aliyuncs.com/v1", "qwen-audio"),
            "wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio",
        )
        self.assertEqual(dialect.audio_format, "pcm")
        self.assertIsNone(dialect.default_voice)

    def test_dashscope_compatible_mode_uses_aliyun_dialect(self):
        dialect = realtime_dialect("https://dashscope.aliyuncs.com/compatible-mode/v1")
        self.assertEqual(
            realtime_url("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-audio-3.0-realtime-plus"),
            "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus",
        )
        self.assertEqual(dialect.audio_format, "pcm")

    def test_existing_api_ws_realtime_url_is_kept(self):
        self.assertEqual(
            realtime_url("wss://example.com/api-ws/v1/realtime", "qwen-audio"),
            "wss://example.com/api-ws/v1/realtime?model=qwen-audio",
        )

    def test_session_update_uses_dialect_and_voice_defaults(self):
        aliyun = session_update_event("", "中文回复", realtime_dialect("https://dashscope.aliyuncs.com/compatible-mode/v1"))
        openai = session_update_event("", "Reply briefly", realtime_dialect("https://api.openai.com/v1"))
        custom = session_update_event("custom-voice", "Reply briefly", realtime_dialect("https://api.openai.com/v1"))
        self.assertEqual(aliyun["session"]["input_audio_format"], "pcm")
        self.assertEqual(aliyun["session"]["output_audio_format"], "pcm")
        self.assertNotIn("voice", aliyun["session"])
        self.assertEqual(openai["session"]["input_audio_format"], "pcm16")
        self.assertEqual(openai["session"]["output_audio_format"], "pcm16")
        self.assertEqual(openai["session"]["voice"], "alloy")
        self.assertEqual(custom["session"]["voice"], "custom-voice")
        self.assertNotIn("input_audio_transcription", aliyun["session"])
        self.assertNotIn("input_audio_transcription", openai["session"])

    def test_log_fields_omit_credentials(self):
        fields = realtime_log_fields("wss://example.com/v1/realtime?model=m&api_key=secret")
        self.assertEqual(fields, {"host": "example.com", "path": "/v1/realtime", "model": "m"})
        self.assertNotIn("secret", json.dumps(fields))

    def test_audio_append_is_base64(self):
        self.assertEqual(
            append_audio_event(b"\x01\x02"),
            {"type": "input_audio_buffer.append", "audio": base64.b64encode(b"\x01\x02").decode()},
        )

    def test_parses_events_and_expands_remote_error(self):
        audio = parse_server_event(json.dumps({"type": "response.audio.delta", "delta": base64.b64encode(b"pcm").decode()}))
        self.assertEqual(audio, ("audio", b"pcm"))
        self.assertEqual(parse_server_event('{"type":"session.created"}'), ("session_created", ""))
        self.assertEqual(parse_server_event('{"type":"session.updated"}'), ("session_updated", ""))
        with self.assertRaisesRegex(RealtimeError, r"invalid_value:bad field"):
            parse_server_event(json.dumps({"type": "error", "error": {"code": "invalid_value", "message": "bad field"}}))

    def test_parses_openai_input_transcript_delta_with_item_identity(self):
        event = parse_server_event(json.dumps({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-openai-1",
            "delta": "你好",
        }))
        self.assertEqual(event, ("input_transcript_delta", {
            "item_id": "item-openai-1",
            "delta": "你好",
            "text": "",
            "stash": "",
        }))

    def test_parses_qwen_input_transcript_snapshot_and_completion(self):
        partial = parse_server_event(json.dumps({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-qwen-1",
            "text": "今天",
            "stash": "天气",
        }))
        completed = parse_server_event(json.dumps({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-qwen-1",
            "transcript": "今天天气很好",
        }))
        self.assertEqual(partial, ("input_transcript_delta", {
            "item_id": "item-qwen-1",
            "delta": "",
            "text": "今天",
            "stash": "天气",
        }))
        self.assertEqual(completed, ("input_transcript_completed", {
            "item_id": "item-qwen-1",
            "transcript": "今天天气很好",
        }))

    def test_realtime_error_code_unwraps_exception_group(self):
        group = ExceptionGroup("task group", [RealtimeError("REALTIME_SESSION_UPDATE_TIMEOUT")])
        self.assertEqual(realtime_error_code(group), "REALTIME_SESSION_UPDATE_TIMEOUT")

    def test_text_command_events_do_not_contain_credentials(self):
        events = [conversation_text_event("重新生成回复"), response_create_event(["text", "audio"])]
        self.assertNotIn("api_key", json.dumps(events))

    def test_agent_and_dockerfile_use_generic_module(self):
        root = Path(__file__).parent
        agent = (root / "agent.py").read_text(encoding="utf-8")
        dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("from openai_realtime import", agent)
        self.assertIn("realtime_track", agent)
        self.assertIn("openai_realtime.py", dockerfile)
        self.assertIn("agent_mode.py", dockerfile)
        self.assertNotIn("qwen_realtime", agent + dockerfile)
        self.assertNotIn("QwenRealtime", agent + dockerfile)


class FakeSocket:
    def __init__(self, messages: list[str]):
        self.messages = list(messages)

    async def recv(self):
        if not self.messages:
            await asyncio.Future()
        return self.messages.pop(0)


class OpenAIRealtimeHandshakeTests(unittest.IsolatedAsyncioTestCase):
    async def test_waits_for_session_updated_after_created(self):
        session = RealtimeSession("wss://example.com/v1", "m-realtime", "k", "", "hi")
        session.socket = FakeSocket(['{"type":"session.created"}', '{"type":"session.updated"}'])
        await session.wait_session_updated()

    async def test_session_update_timeout(self):
        original = openai_realtime.SESSION_UPDATED_TIMEOUT
        openai_realtime.SESSION_UPDATED_TIMEOUT = 0.05
        session = RealtimeSession("wss://example.com/v1", "m-realtime", "k", "", "hi")
        session.socket = FakeSocket([])
        try:
            with self.assertRaisesRegex(RealtimeError, "REALTIME_SESSION_UPDATE_TIMEOUT"):
                await session.wait_session_updated()
        finally:
            openai_realtime.SESSION_UPDATED_TIMEOUT = original


if __name__ == "__main__":
    unittest.main()
