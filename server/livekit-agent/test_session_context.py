import json
import unittest

from session_context import SessionContextError, parse_session_context


class SessionContextTests(unittest.TestCase):
    def test_accepts_versioned_bounded_context(self):
        result = parse_session_context(json.dumps({"v": 1, "role": "interviewer", "topic": "Go", "history": [{"role": "user", "text": "hello"}], "resumeIds": ["r1"]}).encode())
        self.assertEqual(result["role"], "interviewer")
        self.assertEqual(result["resumeIds"], ["r1"])

    def test_rejects_provider_or_secret_fields(self):
        with self.assertRaisesRegex(SessionContextError, "SESSION_CONTEXT_INVALID"):
            parse_session_context(json.dumps({"v": 1, "role": "x", "topic": "", "history": [], "resumeIds": [], "apiKey": "secret"}).encode())


if __name__ == "__main__": unittest.main()
