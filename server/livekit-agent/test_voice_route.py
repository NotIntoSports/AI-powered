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
        self.assertFalse(runtime.e2e.realtime_enabled)

    def test_e2e_route_uses_explicit_realtime_flag_not_model_name(self):
        enabled = parse_voice_route({
            "id": "route-enabled", "mode": "e2e", "active": True, "ready": True,
            "e2e": {"providerId": "custom", "modelId": "audio-model", "baseUrl": "https://example/v1", "apiKey": "secret", "realtimeEnabled": True},
        })
        disabled = parse_voice_route({
            "id": "route-disabled", "mode": "e2e", "active": True, "ready": True,
            "e2e": {"providerId": "custom", "modelId": "contains-realtime", "baseUrl": "https://example/v1", "apiKey": "secret", "realtimeEnabled": False},
        })
        self.assertTrue(enabled.e2e.realtime_enabled)
        self.assertFalse(disabled.e2e.realtime_enabled)

    def test_agent_does_not_route_by_model_name(self):
        from pathlib import Path
        source = Path(__file__).with_name("agent.py").read_text(encoding="utf-8")
        self.assertNotIn('"realtime" in', source)
        self.assertIn("e2e_config.realtime_enabled", source)

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
