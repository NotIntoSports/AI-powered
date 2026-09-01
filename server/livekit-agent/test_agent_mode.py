import unittest

from agent_mode import AgentModeState


class AgentModeStateTests(unittest.TestCase):
    def test_operator_and_paused_modes_suppress_answers_until_manual_resume(self):
        state = AgentModeState()
        self.assertTrue(state.can_answer())

        operator_generation = state.set_mode("operator-speaking")
        self.assertFalse(state.can_answer())

        paused_generation = state.set_mode("paused")
        self.assertFalse(state.can_answer())
        self.assertGreater(paused_generation, operator_generation)

        state.set_mode("ai-active")
        self.assertTrue(state.can_answer())

    def test_muted_mode_suppresses_answers(self):
        state = AgentModeState()
        self.assertEqual(state.answer_generation(), 0)
        state.set_mode("muted")
        self.assertFalse(state.can_answer())
        self.assertEqual(state.answer_generation(), -1)


if __name__ == "__main__":
    unittest.main()
