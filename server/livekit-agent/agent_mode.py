VALID_AGENT_MODES = frozenset({"ai-active", "operator-speaking", "paused", "muted"})


class AgentModeState:
    def __init__(self) -> None:
        self.mode = "ai-active"
        self.generation = 0

    def set_mode(self, mode: str) -> int:
        if mode not in VALID_AGENT_MODES:
            raise ValueError("AGENT_MODE_INVALID")
        if mode != self.mode:
            self.mode = mode
            self.generation += 1
        return self.generation

    def can_answer(self) -> bool:
        return self.mode == "ai-active"

    def answer_generation(self) -> int:
        return self.generation if self.can_answer() else -1
