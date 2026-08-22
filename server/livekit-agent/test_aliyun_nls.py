import json
import os
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from aliyun_nls import (
    AliyunNlsConfig,
    AliyunNlsError,
    AliyunNlsSession,
    AliyunTokenProvider,
    build_create_token_url,
)


class AliyunNlsConfigTests(unittest.TestCase):
    def test_requires_appkey_and_credentials(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(AliyunNlsError, "APPKEY_MISSING"):
                AliyunNlsConfig.from_env()

        with patch.dict(os.environ, {"ALIYUN_NLS_APPKEY": "app"}, clear=True):
            with self.assertRaisesRegex(AliyunNlsError, "CREDENTIALS_MISSING"):
                AliyunNlsConfig.from_env()

    def test_accepts_token_and_normalizes_gateway(self):
        with patch.dict(
            os.environ,
            {
                "ALIYUN_NLS_APPKEY": "app",
                "ALIYUN_NLS_TOKEN": "token",
                "ALIYUN_NLS_GATEWAY": "https://example.com/",
            },
            clear=True,
        ):
            config = AliyunNlsConfig.from_env()
        self.assertEqual(config.websocket_url, "wss://example.com/ws/v1")

    def test_create_token_signature_matches_existing_contract_vector(self):
        url = build_create_token_url(
            "LTAItestkey",
            "testsecret",
            "2019-04-03T06:15:03Z",
            "8d1e6a7a-f44e-40d5-aedb-fe4a1c80f434",
        )
        signature = parse_qs(urlsplit(url).query)["Signature"][0]
        self.assertEqual(signature, "KjcxMs8/vyjkFEh3OCW/VaUzv7o=")
        self.assertNotIn("testsecret", url)


class AliyunNlsEventTests(unittest.IsolatedAsyncioTestCase):
    async def test_maps_interim_and_final_events(self):
        config = AliyunNlsConfig(app_key="app", token="token")
        session = AliyunNlsSession(config, AliyunTokenProvider(config))

        class Socket:
            def __init__(self):
                self.messages = iter(
                    [
                        json.dumps(
                            {
                                "header": {"name": "TranscriptionResultChanged"},
                                "payload": {"index": 3, "result": "你好"},
                            }
                        ),
                        json.dumps(
                            {
                                "header": {"name": "SentenceEnd"},
                                "payload": {"index": 3, "result": "你好。"},
                            }
                        ),
                        json.dumps({"header": {"name": "TranscriptionCompleted"}}),
                    ]
                )

            def __aiter__(self):
                return self

            async def __anext__(self):
                try:
                    return next(self.messages)
                except StopIteration:
                    raise StopAsyncIteration

        session._socket = Socket()
        results = [result async for result in session.results()]
        self.assertEqual([result.text for result in results], ["你好", "你好。"])
        self.assertEqual([result.final for result in results], [False, True])
        self.assertEqual(results[0].utterance_id, results[1].utterance_id)


if __name__ == "__main__":
    unittest.main()
