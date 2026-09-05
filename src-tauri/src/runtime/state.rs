use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    Idle,
    Preparing,
    Listening,
    Thinking,
    Speaking,
    Stopping,
    Completed,
    Recovering,
    Blocked,
    Failed,
}

impl SessionPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Preparing => "preparing",
            Self::Listening => "listening",
            Self::Thinking => "thinking",
            Self::Speaking => "speaking",
            Self::Stopping => "stopping",
            Self::Completed => "completed",
            Self::Recovering => "recovering",
            Self::Blocked => "blocked",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentMode {
    AiActive,
    OperatorSpeaking,
    Paused,
    Muted,
}

impl AgentMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AiActive => "ai_active",
            Self::OperatorSpeaking => "operator_speaking",
            Self::Paused => "paused",
            Self::Muted => "muted",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "ai_active" => Some(Self::AiActive),
            "operator_speaking" => Some(Self::OperatorSpeaking),
            "paused" => Some(Self::Paused),
            "muted" => Some(Self::Muted),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeError {
    StateInvalid,
}

impl RuntimeError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::StateInvalid => "SESSION_STATE_INVALID",
        }
    }
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for RuntimeError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeEvent {
    Phase(SessionPhase),
    Mode(AgentMode),
    Takeover,
}

#[derive(Debug, Clone)]
pub struct SessionRuntime {
    phase: SessionPhase,
    mode: AgentMode,
    last_seq: Option<u64>,
    stop_tts: bool,
}

impl Default for SessionRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionRuntime {
    pub fn new() -> Self {
        Self {
            phase: SessionPhase::Idle,
            mode: AgentMode::AiActive,
            last_seq: None,
            stop_tts: false,
        }
    }

    pub fn phase(&self) -> SessionPhase {
        self.phase
    }

    pub fn mode(&self) -> AgentMode {
        self.mode
    }

    pub fn last_seq(&self) -> Option<u64> {
        self.last_seq
    }

    pub fn stop_tts(&self) -> bool {
        self.stop_tts
    }

    pub fn take_stop_tts(&mut self) -> bool {
        std::mem::replace(&mut self.stop_tts, false)
    }

    pub fn can_answer(&self) -> bool {
        self.mode == AgentMode::AiActive
    }

    pub fn transition(&mut self, next: SessionPhase) -> Result<(), RuntimeError> {
        if !is_legal_transition(self.phase, next) {
            return Err(RuntimeError::StateInvalid);
        }
        self.phase = next;
        Ok(())
    }

    pub fn apply_event(&mut self, seq: u64, event: RuntimeEvent) -> Result<bool, RuntimeError> {
        if self.last_seq.is_some_and(|last| seq <= last) {
            return Ok(false);
        }
        match event {
            RuntimeEvent::Phase(next) => self.transition(next)?,
            RuntimeEvent::Mode(mode) => self.set_mode(mode),
            RuntimeEvent::Takeover => self.takeover(),
        }
        self.last_seq = Some(seq);
        Ok(true)
    }

    pub fn takeover(&mut self) {
        self.mode = AgentMode::OperatorSpeaking;
        self.stop_tts = true;
    }

    pub fn set_mode(&mut self, mode: AgentMode) {
        self.stop_tts = mode != AgentMode::AiActive;
        self.mode = mode;
    }
}

fn is_legal_transition(from: SessionPhase, to: SessionPhase) -> bool {
    if from == to || from == SessionPhase::Completed {
        return false;
    }
    match (from, to) {
        (SessionPhase::Idle, SessionPhase::Preparing)
        | (SessionPhase::Preparing, SessionPhase::Listening)
        | (SessionPhase::Listening, SessionPhase::Thinking)
        | (SessionPhase::Thinking, SessionPhase::Speaking)
        | (SessionPhase::Speaking, SessionPhase::Listening)
        | (SessionPhase::Stopping, SessionPhase::Completed) => true,
        (_, SessionPhase::Stopping) => from != SessionPhase::Stopping,
        (_, SessionPhase::Recovering | SessionPhase::Blocked | SessionPhase::Failed) => {
            !matches!(from, SessionPhase::Stopping)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentMode, RuntimeError, RuntimeEvent, SessionPhase, SessionRuntime};

    #[test]
    fn happy_path_and_stop_transitions_are_legal() {
        let mut runtime = SessionRuntime::new();
        assert_eq!(runtime.phase(), SessionPhase::Idle);

        let happy = [
            SessionPhase::Preparing,
            SessionPhase::Listening,
            SessionPhase::Thinking,
            SessionPhase::Speaking,
            SessionPhase::Listening,
        ];
        for next in happy {
            runtime
                .transition(next)
                .unwrap_or_else(|_| panic!("{}", next_label(next)));
            assert_eq!(runtime.phase(), next);
        }

        runtime
            .transition(SessionPhase::Stopping)
            .expect("listening -> stopping");
        runtime
            .transition(SessionPhase::Completed)
            .expect("stopping -> completed");
        assert_eq!(runtime.phase(), SessionPhase::Completed);
    }

    #[test]
    fn illegal_transitions_return_session_state_invalid() {
        let cases = [
            (SessionPhase::Idle, SessionPhase::Speaking),
            (SessionPhase::Idle, SessionPhase::Listening),
            (SessionPhase::Listening, SessionPhase::Idle),
            (SessionPhase::Speaking, SessionPhase::Thinking),
            (SessionPhase::Thinking, SessionPhase::Listening),
            (SessionPhase::Completed, SessionPhase::Listening),
            (SessionPhase::Completed, SessionPhase::Stopping),
            (SessionPhase::Failed, SessionPhase::Listening),
            (SessionPhase::Blocked, SessionPhase::Preparing),
        ];

        for (from, to) in cases {
            let mut runtime = SessionRuntime::new();
            force_phase(&mut runtime, from);
            let error = runtime.transition(to).expect_err("illegal transition");
            assert_eq!(error, RuntimeError::StateInvalid);
            assert_eq!(error.code(), "SESSION_STATE_INVALID");
            assert_eq!(runtime.phase(), from);
        }
    }

    #[test]
    fn any_non_terminal_phase_can_stop_or_enter_exceptions() {
        let origins = [
            SessionPhase::Idle,
            SessionPhase::Preparing,
            SessionPhase::Listening,
            SessionPhase::Thinking,
            SessionPhase::Speaking,
            SessionPhase::Recovering,
        ];
        for from in origins {
            let mut runtime = SessionRuntime::new();
            force_phase(&mut runtime, from);
            runtime
                .transition(SessionPhase::Stopping)
                .unwrap_or_else(|_| panic!("{from:?} -> stopping"));
            assert_eq!(runtime.phase(), SessionPhase::Stopping);
        }

        for from in [
            SessionPhase::Idle,
            SessionPhase::Listening,
            SessionPhase::Speaking,
        ] {
            for exception in [
                SessionPhase::Recovering,
                SessionPhase::Blocked,
                SessionPhase::Failed,
            ] {
                let mut runtime = SessionRuntime::new();
                force_phase(&mut runtime, from);
                runtime.transition(exception).unwrap();
                assert_eq!(runtime.phase(), exception);
            }
        }

        let mut failed = SessionRuntime::new();
        force_phase(&mut failed, SessionPhase::Failed);
        failed.transition(SessionPhase::Stopping).unwrap();
        assert_eq!(failed.phase(), SessionPhase::Stopping);
    }

    #[test]
    fn apply_event_ignores_stale_or_duplicate_seq() {
        let mut runtime = SessionRuntime::new();
        assert!(
            runtime
                .apply_event(0, RuntimeEvent::Phase(SessionPhase::Preparing))
                .unwrap()
        );
        assert_eq!(runtime.phase(), SessionPhase::Preparing);
        assert_eq!(runtime.last_seq(), Some(0));

        assert!(
            !runtime
                .apply_event(0, RuntimeEvent::Phase(SessionPhase::Listening))
                .unwrap()
        );
        assert!(
            !runtime
                .apply_event(0, RuntimeEvent::Phase(SessionPhase::Listening))
                .unwrap()
        );
        assert_eq!(runtime.phase(), SessionPhase::Preparing);

        assert!(
            runtime
                .apply_event(2, RuntimeEvent::Phase(SessionPhase::Listening))
                .unwrap()
        );
        assert_eq!(runtime.phase(), SessionPhase::Listening);
        assert_eq!(runtime.last_seq(), Some(2));

        assert!(
            !runtime
                .apply_event(1, RuntimeEvent::Phase(SessionPhase::Thinking))
                .unwrap()
        );
        assert_eq!(runtime.phase(), SessionPhase::Listening);
    }

    #[test]
    fn takeover_blocks_answers_and_requests_tts_stop() {
        let mut runtime = SessionRuntime::new();
        assert!(runtime.can_answer());
        assert!(!runtime.stop_tts());
        assert_eq!(runtime.mode(), AgentMode::AiActive);

        runtime.takeover();
        assert_eq!(runtime.mode(), AgentMode::OperatorSpeaking);
        assert!(!runtime.can_answer());
        assert!(runtime.stop_tts());

        runtime.set_mode(AgentMode::Paused);
        assert!(!runtime.can_answer());
        assert!(runtime.stop_tts());
        runtime.set_mode(AgentMode::Muted);
        assert!(!runtime.can_answer());
        assert!(runtime.stop_tts());
        runtime.set_mode(AgentMode::AiActive);
        assert!(runtime.can_answer());
        assert!(!runtime.stop_tts());
    }

    #[test]
    fn resume_ai_clears_stop_tts_after_takeover() {
        let mut runtime = SessionRuntime::new();
        runtime.takeover();
        assert!(runtime.stop_tts());
        assert!(!runtime.can_answer());

        runtime.set_mode(AgentMode::AiActive);
        assert!(!runtime.stop_tts());
        assert!(runtime.can_answer());
        assert_eq!(runtime.mode(), AgentMode::AiActive);
    }

    fn next_label(phase: SessionPhase) -> &'static str {
        match phase {
            SessionPhase::Preparing => "idle -> preparing",
            SessionPhase::Listening => "-> listening",
            SessionPhase::Thinking => "listening -> thinking",
            SessionPhase::Speaking => "thinking -> speaking",
            _ => "transition",
        }
    }

    fn force_phase(runtime: &mut SessionRuntime, target: SessionPhase) {
        if target == SessionPhase::Idle {
            return;
        }
        let path: &[SessionPhase] = match target {
            SessionPhase::Preparing => &[SessionPhase::Preparing],
            SessionPhase::Listening => &[SessionPhase::Preparing, SessionPhase::Listening],
            SessionPhase::Thinking => &[
                SessionPhase::Preparing,
                SessionPhase::Listening,
                SessionPhase::Thinking,
            ],
            SessionPhase::Speaking => &[
                SessionPhase::Preparing,
                SessionPhase::Listening,
                SessionPhase::Thinking,
                SessionPhase::Speaking,
            ],
            SessionPhase::Stopping => &[SessionPhase::Preparing, SessionPhase::Stopping],
            SessionPhase::Completed => &[
                SessionPhase::Preparing,
                SessionPhase::Stopping,
                SessionPhase::Completed,
            ],
            SessionPhase::Recovering => &[SessionPhase::Recovering],
            SessionPhase::Blocked => &[SessionPhase::Blocked],
            SessionPhase::Failed => &[SessionPhase::Failed],
            SessionPhase::Idle => &[],
        };
        for phase in path {
            runtime
                .transition(*phase)
                .unwrap_or_else(|_| panic!("force {target:?} via {phase:?}"));
        }
    }
}
