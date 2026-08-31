import base64
import json
import unittest

from qwen_realtime import append_audio_event, conversation_text_event, parse_server_event, realtime_url, response_create_event, session_update_event


class QwenRealtimeTests(unittest.TestCase):
    def test_token_plan_url_uses_websocket_realtime_endpoint(self):
        self.assertEqual(realtime_url("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "qwen-audio"), "wss://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/realtime?model=qwen-audio")

    def test_audio_append_is_pcm_base64(self):
        event = append_audio_event(b"\x01\x02")
        self.assertEqual(event, {"type": "input_audio_buffer.append", "audio": base64.b64encode(b"\x01\x02").decode()})

    def test_session_update_requests_audio_and_server_vad(self):
        event = session_update_event("Cherry", "中文回复")
        self.assertIn("audio", event["session"]["modalities"])
        self.assertEqual(event["session"]["turn_detection"]["type"], "server_vad")

    def test_parses_audio_and_transcript_deltas(self):
        audio = parse_server_event(json.dumps({"type": "response.audio.delta", "delta": base64.b64encode(b"pcm").decode()}))
        transcript = parse_server_event(json.dumps({"type": "response.audio_transcript.delta", "delta": "你好"}))
        self.assertEqual(audio, ("audio", b"pcm"))
        self.assertEqual(transcript, ("output_transcript", "你好"))
        completed = parse_server_event(json.dumps({"type": "conversation.item.input_audio_transcription.completed", "transcript": "回答"}))
        done = parse_server_event(json.dumps({"type": "response.done"}))
        self.assertEqual(completed, ("input_transcript", "回答"))
        self.assertEqual(done, ("response_done", ""))

    def test_builds_text_command_events_without_credentials(self):
        item = conversation_text_event("重新生成回复")
        response = response_create_event(["text", "audio"])
        self.assertEqual(item["item"]["content"][0]["text"], "重新生成回复")
        self.assertEqual(response["response"]["modalities"], ["text", "audio"])
        self.assertNotIn("api_key", json.dumps([item, response]))

    def test_parses_text_delta(self):
        self.assertEqual(
            parse_server_event(json.dumps({"type": "response.text.delta", "delta": "纪要"})),
            ("output_text", "纪要"),
        )


if __name__ == "__main__": unittest.main()
