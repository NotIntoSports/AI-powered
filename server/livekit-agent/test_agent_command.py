import json
import asyncio
import unittest

from agent_command import AgentCommandError, command_requirements, execute_agent_command, parse_agent_command, result_packet


class AgentCommandTests(unittest.TestCase):
    def test_report_requires_generation_but_not_audio(self):
        self.assertEqual(command_requirements("report"), {"generate"})
        self.assertEqual(command_requirements("retry"), {"generate", "speak"})
        self.assertEqual(command_requirements("say"), {"speak"})

    def test_parses_versioned_retry_command(self):
        command = parse_agent_command(json.dumps({"v": 1, "id": "cmd-1", "action": "retry", "expectedRevision": 4}).encode())
        self.assertEqual(command.action, "retry")
        self.assertEqual(command.expected_revision, 4)

    def test_parses_agent_mode_command_without_generation_requirements(self):
        command = parse_agent_command(json.dumps({
            "v": 1,
            "id": "cmd-mode-1",
            "action": "set_mode",
            "mode": "operator-speaking",
        }).encode())
        self.assertEqual(command.action, "set_mode")
        self.assertEqual(command.mode, "operator-speaking")
        self.assertEqual(command_requirements(command.action), set())

    def test_rejects_unknown_agent_mode(self):
        with self.assertRaisesRegex(AgentCommandError, "AGENT_COMMAND_INVALID"):
            parse_agent_command(json.dumps({
                "v": 1,
                "id": "cmd-mode-2",
                "action": "set_mode",
                "mode": "guess-the-speaker",
            }).encode())

    def test_rejects_model_or_secret_fields(self):
        with self.assertRaisesRegex(AgentCommandError, "AGENT_COMMAND_INVALID"):
            parse_agent_command(json.dumps({"v": 1, "id": "cmd-1", "action": "say", "text": "hi", "modelId": "x"}).encode())

    def test_result_packet_carries_command_correlation(self):
        packet = json.loads(result_packet("cmd-1", "retry", {"question": "下一题"}))
        self.assertEqual(packet["commandId"], "cmd-1")
        self.assertEqual(packet["result"]["question"], "下一题")

    def test_retry_generates_and_speaks_question(self):
        spoken = []
        async def generate(_prompt, _context): return "下一题"
        async def speak(text): spoken.append(text)
        command = parse_agent_command(json.dumps({"v": 1, "id": "cmd-1", "action": "retry", "expectedRevision": 4}).encode())
        result = asyncio.run(execute_agent_command(command, {}, generate, speak))
        self.assertEqual(result, {"question": "下一题", "expectedRevision": 4})
        self.assertEqual(spoken, ["下一题"])

    def test_report_generates_without_speaking(self):
        spoken = []
        async def generate(_prompt, _context): return '{"summary":"摘要","strengths":[],"followUps":[],"limitations":[],"evidence":[]}'
        async def speak(text): spoken.append(text)
        command = parse_agent_command(json.dumps({"v": 1, "id": "cmd-2", "action": "report"}).encode())
        result = asyncio.run(execute_agent_command(command, {}, generate, speak))
        self.assertEqual(result["report"]["summary"], "摘要")
        self.assertEqual(spoken, [])

    def test_report_normalizes_incomplete_model_json(self):
        async def generate(_prompt, _context): return '{"summary":"摘要","strengths":"错误类型","evidence":[{"topic":"主题"}]}'
        async def speak(_text): raise AssertionError("report must not speak")
        command = parse_agent_command(json.dumps({"v": 1, "id": "cmd-3", "action": "report"}).encode())
        report = asyncio.run(execute_agent_command(command, {}, generate, speak))["report"]
        self.assertEqual(report["strengths"], [])
        self.assertEqual(report["evidence"], [])
        self.assertEqual(report["followUps"], [])


if __name__ == "__main__": unittest.main()
