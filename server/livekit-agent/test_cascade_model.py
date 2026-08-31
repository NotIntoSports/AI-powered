import json
import asyncio
import unittest
from unittest.mock import patch

from cascade_model import CascadeModelError, build_asr_multipart, build_llm_request, build_tts_request, pcm_frames, run_cascade_turn
from voice_route import ModelEndpoint


class CascadeModelTests(unittest.TestCase):
    def test_llm_request_carries_versioned_context_without_credentials(self):
        endpoint = ModelEndpoint("provider", "qwen-plus", "https://example/v1", "secret", "ai")
        body = build_llm_request(endpoint, "候选人回答", {"v": 1, "role": "interviewer", "topic": "Go", "history": [{"role": "user", "text": "hi"}]})
        encoded = json.dumps(body, ensure_ascii=False)
        self.assertEqual(body["model"], "qwen-plus")
        self.assertIn("候选人回答", encoded)
        self.assertNotIn("secret", encoded)

    def test_tts_requests_pcm_for_livekit_publication(self):
        endpoint = ModelEndpoint("provider", "qwen-tts", "https://example/v1", "secret", "ai")
        body = build_tts_request(endpoint, "你好", "Cherry")
        self.assertEqual(body["response_format"], "pcm")
        self.assertEqual(body["voice"], "Cherry")

    def test_asr_multipart_contains_model_and_wav_without_key(self):
        endpoint = ModelEndpoint("provider", "qwen-asr", "https://example/v1", "secret", "ai")
        body, content_type = build_asr_multipart(endpoint, b"RIFFaudio")
        self.assertIn("multipart/form-data; boundary=", content_type)
        self.assertIn(b'qwen-asr', body)
        self.assertIn(b'RIFFaudio', body)
        self.assertNotIn(b'secret', body)

    def test_pcm_frames_rejects_partial_samples(self):
        with self.assertRaisesRegex(CascadeModelError, "TTS_PCM_INVALID"):
            list(pcm_frames(b"\x00", sample_rate=24000))

    def test_pcm_frames_are_20ms_mono_chunks(self):
        chunks = list(pcm_frames(bytes(24000 * 2 // 50 * 2), sample_rate=24000))
        self.assertEqual([len(chunk) for chunk in chunks], [960, 960])

    def test_cascade_turn_calls_llm_then_tts(self):
        llm = ModelEndpoint("llm", "qwen-plus", "https://example/v1", "llm-key", "ai")
        tts = ModelEndpoint("tts", "qwen-tts", "https://example/v1", "tts-key", "ai")
        with patch("cascade_model.call_llm", return_value="下一题") as llm_call, patch("cascade_model.call_tts", return_value=b"\x00\x00") as tts_call:
            reply, pcm = asyncio.run(run_cascade_turn(llm, tts, "回答", "Cherry", {"v": 1}))
        self.assertEqual((reply, pcm), ("下一题", b"\x00\x00"))
        llm_call.assert_called_once()
        tts_call.assert_called_once_with(tts, "下一题", "Cherry")


if __name__ == "__main__":
    unittest.main()
