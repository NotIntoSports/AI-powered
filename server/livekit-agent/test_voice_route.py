import unittest

from voice_route import VoiceRouteError, parse_voice_route


class VoiceRouteTests(unittest.TestCase):
    def test_e2e_route_uses_embedded_endpoint(self):
        runtime = parse_voice_route({
            "id": "route-1", "mode": "e2e", "active": True, "ready": True,
            "e2e": {"providerId": "tp", "modelId": "qwen-audio", "baseUrl": "https://example/v1", "apiKey": "secret"},
        })
        self.assertEqual(runtime.route_id, "route-1")
        self.assertEqual(runtime.e2e.model, "qwen-audio")

    def test_not_ready_is_explicit(self):
        with self.assertRaisesRegex(VoiceRouteError, "VOICE_ROUTE_NOT_READY"):
            parse_voice_route({"id": "route-1", "mode": "cascaded", "active": True, "ready": False})

    def test_cascaded_route_requires_all_stages(self):
        with self.assertRaisesRegex(VoiceRouteError, "VOICE_ROUTE_NOT_READY"):
            parse_voice_route({"id": "route-1", "mode": "cascaded", "active": True, "ready": True, "asr": {}})

    def test_agent_logs_underlying_load_error_code(self):
        from pathlib import Path
        source = Path(__file__).with_name("agent.py").read_text(encoding="utf-8")
        self.assertIn('"code": str(exc)[:80]', source)
        self.assertIn("VOICE_ROUTE_NOT_READY", source)


if __name__ == "__main__":
    unittest.main()
