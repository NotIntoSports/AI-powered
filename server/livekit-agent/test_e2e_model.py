import json
import unittest

from e2e_model import (
    AudioTurnBuffer,
    E2EConfig,
    E2EModelError,
    build_chat_request,
    call_e2e,
    chat_completions_url,
    pcm_to_wav_base64,
)


class E2EConfigTests(unittest.TestCase):
    def test_from_dict_requires_credentials(self):
        with self.assertRaisesRegex(E2EModelError, "E2E_BASE_URL_MISSING"):
            E2EConfig.from_dict({"model": "demo", "apiKey": "sk-test"})
        with self.assertRaisesRegex(E2EModelError, "E2E_MODEL_MISSING"):
            E2EConfig.from_dict({"baseUrl": "https://api.example.com/v1", "apiKey": "sk-test"})
        with self.assertRaisesRegex(E2EModelError, "E2E_API_KEY_MISSING"):
            E2EConfig.from_dict({"baseUrl": "https://api.example.com/v1", "model": "demo"})

    def test_from_dict_normalizes_fields(self):
        config = E2EConfig.from_dict(
            {
                "baseUrl": "https://api.example.com/v1/",
                "model": "qwen-audio-3.0-realtime-plus",
                "apiKey": "sk-sp-test",
                "questionTimeoutMs": 45_000,
                "language": "en",
                "enabled": True,
            }
        )
        self.assertEqual(config.base_url, "https://api.example.com/v1")
        self.assertEqual(config.model, "qwen-audio-3.0-realtime-plus")
        self.assertEqual(config.timeout_ms, 45_000)
        self.assertEqual(config.language, "en")


class AudioTurnBufferTests(unittest.TestCase):
    def test_emits_after_speech_and_silence(self):
        buffer = AudioTurnBuffer(min_speech_ms=20, silence_ms=40, max_buffer_ms=500, rms_threshold=100)
        voiced = b"\x00\x80" * 320
        silent = b"\x00\x00" * 320
        self.assertIsNone(buffer.push(voiced))
        self.assertIsNone(buffer.push(voiced))
        chunk = None
        for _ in range(6):
            chunk = buffer.push(silent)
            if chunk is not None:
                break
        self.assertIsNotNone(chunk)
        self.assertGreater(len(chunk or b""), 0)


class E2EApiTests(unittest.TestCase):
    def test_chat_completions_url(self):
        self.assertEqual(
            chat_completions_url("https://api.example.com/v1"),
            "https://api.example.com/v1/chat/completions",
        )
        self.assertEqual(
            chat_completions_url("https://api.example.com/v1/chat/completions"),
            "https://api.example.com/v1/chat/completions",
        )

    def test_build_chat_request_contains_audio(self):
        config = E2EConfig(
            base_url="https://api.example.com/v1",
            model="demo",
            api_key="sk-test",
            language="zh",
        )
        pcm = b"\x00\x01" * 8000
        request = build_chat_request(config, pcm)
        content = request["messages"][1]["content"]
        self.assertEqual(content[0]["type"], "input_audio")
        self.assertTrue(content[0]["input_audio"]["data"])
        self.assertEqual(content[0]["input_audio"]["format"], "wav")

    def test_pcm_to_wav_base64_roundtrip_header(self):
        encoded = pcm_to_wav_base64(b"\x00\x01" * 100)
        self.assertTrue(len(encoded) > 20)

    def test_call_e2e_parses_json_response(self):
        config = E2EConfig(
            base_url="https://api.example.com/v1",
            model="demo",
            api_key="sk-test",
        )
        pcm = b"\x00\x80" * 8000

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b""

        payload = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"transcript": "你好", "reply": "请介绍一下你自己"},
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

        def fake_urlopen(_request, timeout=0):
            class Reader:
                def __enter__(self_inner):
                    return self_inner

                def __exit__(self_inner, *_args):
                    return False

                def read(self_inner):
                    return json.dumps(payload).encode("utf-8")

            return Reader()

        from unittest.mock import patch

        with patch("e2e_model.urlopen", fake_urlopen):
            result = call_e2e(config, pcm, "utt-1")
        self.assertEqual(result.utterance_id, "utt-1")
        self.assertEqual(result.transcript, "你好")
        self.assertEqual(result.reply, "请介绍一下你自己")


if __name__ == "__main__":
    unittest.main()
