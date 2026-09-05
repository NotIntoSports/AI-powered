use std::sync::atomic::{AtomicBool, Ordering};

use crate::{
    audio::{ASR_SAMPLE_RATE, AudioCapture, AudioError, NoopSink, PlaybackSink, SidecarPoll},
    config::PublicConfig,
    database::{Database, DatabaseError},
    providers::{CascadeError, ChatModel, EmbeddingProbe, SpeechToText, TextToSpeech},
    runtime::{
        AgentMode, CascadeCredentials, CascadeTurn, CascadeTurnDeps, CascadeTurnRequest,
        HistoryTurn, PreflightIssue, RuntimeError, SessionPhase, SessionRuntime,
        active_role_profile, active_voice_route, build_snapshot, preflight, run_cascade_turn,
    },
    sessions::{NewCitation, NewSession, NewSnapshot, NewTurn, SessionRecord, SessionStore},
};

#[derive(Debug)]
pub enum SessionServiceError {
    AlreadyActive,
    NotFound,
    StateInvalid,
    SidecarFailed,
    Cascade(CascadeError),
    Audio(AudioError),
    Database(DatabaseError),
}

impl SessionServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AlreadyActive => "SESSION_ALREADY_ACTIVE",
            Self::NotFound => "SESSION_NOT_FOUND",
            Self::StateInvalid => "SESSION_STATE_INVALID",
            Self::SidecarFailed => "SESSION_SIDECAR_FAILED",
            Self::Cascade(error) => error.code(),
            Self::Audio(error) => error.code(),
            Self::Database(error) => error.code(),
        }
    }
}

impl From<CascadeError> for SessionServiceError {
    fn from(error: CascadeError) -> Self {
        Self::Cascade(error)
    }
}

impl From<AudioError> for SessionServiceError {
    fn from(error: AudioError) -> Self {
        if error == AudioError::SidecarFailed {
            Self::SidecarFailed
        } else {
            Self::Audio(error)
        }
    }
}

impl From<DatabaseError> for SessionServiceError {
    fn from(error: DatabaseError) -> Self {
        Self::Database(error)
    }
}

impl From<RuntimeError> for SessionServiceError {
    fn from(_: RuntimeError) -> Self {
        Self::StateInvalid
    }
}

#[derive(Debug)]
pub enum SessionStartOutcome {
    Started { session: SessionRecord },
    Blocked { issues: Vec<PreflightIssue> },
}

pub struct SessionProbes<'a> {
    pub asr: &'a dyn SpeechToText,
    pub llm: &'a dyn ChatModel,
    pub tts: &'a dyn TextToSpeech,
    pub embed: &'a dyn EmbeddingProbe,
}

pub struct SessionService<S: PlaybackSink = NoopSink> {
    runtime: SessionRuntime,
    session_id: Option<String>,
    capture: AudioCapture,
    sink: S,
    cancel: AtomicBool,
    turn_index: i64,
}

impl SessionService<NoopSink> {
    pub fn new() -> Self {
        Self::with_sink(NoopSink)
    }
}

impl Default for SessionService<NoopSink> {
    fn default() -> Self {
        Self::new()
    }
}

impl<S: PlaybackSink> SessionService<S> {
    pub fn with_sink(sink: S) -> Self {
        Self {
            runtime: SessionRuntime::new(),
            session_id: None,
            capture: AudioCapture::from_injected(),
            sink,
            cancel: AtomicBool::new(false),
            turn_index: 0,
        }
    }

    pub fn phase(&self) -> SessionPhase {
        self.runtime.phase()
    }

    pub fn mode(&self) -> AgentMode {
        self.runtime.mode()
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn capture(&self) -> &AudioCapture {
        &self.capture
    }

    pub fn capture_mut(&mut self) -> &mut AudioCapture {
        &mut self.capture
    }

    pub fn sink(&self) -> &S {
        &self.sink
    }

    #[cfg(test)]
    fn runtime_can_answer(&self) -> bool {
        self.runtime.can_answer()
    }

    pub fn start(
        &mut self,
        database: &Database,
        config: &PublicConfig,
        secrets_ready: bool,
    ) -> Result<SessionStartOutcome, SessionServiceError> {
        let issues = preflight(config, secrets_ready, true);
        if !issues.is_empty() {
            return Ok(SessionStartOutcome::Blocked { issues });
        }

        let store = SessionStore::new(database);
        if self.has_active_session()
            || store
                .list()?
                .iter()
                .any(|session| !is_terminal_status(&session.status))
        {
            return Err(SessionServiceError::AlreadyActive);
        }

        self.reset_runtime();
        let session_id = uuid::Uuid::new_v4().to_string();
        let role_profile_id = active_role_profile(config)
            .map(|profile| profile.id.as_str())
            .unwrap_or_default();
        let voice_route_id = active_voice_route(config)
            .map(|route| route.id.as_str())
            .unwrap_or_default();
        store.insert_session(NewSession {
            id: &session_id,
            status: "preparing",
            role_profile_id,
            voice_route_id,
            transport_mode: "direct",
        })?;
        persist_snapshot(&store, &session_id, config)?;
        self.session_id = Some(session_id.clone());
        self.runtime.transition(SessionPhase::Preparing)?;
        persist_phase(&store, &session_id, SessionPhase::Preparing)?;
        self.runtime.transition(SessionPhase::Listening)?;
        persist_phase(&store, &session_id, SessionPhase::Listening)?;
        let session = store
            .get(&session_id)?
            .ok_or(SessionServiceError::NotFound)?;
        Ok(SessionStartOutcome::Started { session })
    }

    pub fn stop(&mut self, database: &Database) -> Result<SessionRecord, SessionServiceError> {
        let session_id = self
            .session_id
            .clone()
            .ok_or(SessionServiceError::NotFound)?;
        self.cancel.store(true, Ordering::SeqCst);
        self.sink.cancel();
        let store = SessionStore::new(database);
        if self.runtime.phase() == SessionPhase::Completed {
            return store.get(&session_id)?.ok_or(SessionServiceError::NotFound);
        }
        self.runtime.transition(SessionPhase::Stopping)?;
        persist_phase(&store, &session_id, SessionPhase::Stopping)?;
        self.runtime.transition(SessionPhase::Completed)?;
        store.finish(&session_id, "completed")?;
        store.append_event(
            &session_id,
            "status",
            &status_payload(SessionPhase::Completed),
        )?;
        store.get(&session_id)?.ok_or(SessionServiceError::NotFound)
    }

    pub fn set_mode(
        &mut self,
        database: &Database,
        mode: AgentMode,
    ) -> Result<AgentMode, SessionServiceError> {
        self.runtime.set_mode(mode);
        if self.runtime.take_stop_tts() {
            self.sink.cancel();
        }
        if let Some(session_id) = &self.session_id {
            SessionStore::new(database).append_event(
                session_id,
                "takeover",
                &serde_json::json!({ "mode": mode_name(mode) }).to_string(),
            )?;
        }
        Ok(self.runtime.mode())
    }

    pub fn push_pcm(&mut self, pcm: &[u8]) {
        self.capture.push_pcm(pcm);
    }

    pub fn finalize_utterance(
        &mut self,
        database: &Database,
        config: &PublicConfig,
        probes: &SessionProbes<'_>,
        credentials: CascadeCredentials<'_>,
        text: Option<&str>,
    ) -> Result<Option<CascadeTurn>, SessionServiceError> {
        self.poll_sidecar(database)?;
        if !self.runtime.can_answer() {
            return Ok(None);
        }
        let session_id = self
            .session_id
            .clone()
            .ok_or(SessionServiceError::NotFound)?;
        self.runtime.transition(SessionPhase::Thinking)?;
        let store = SessionStore::new(database);
        persist_phase(&store, &session_id, SessionPhase::Thinking)?;

        let config = with_default_voice(config);
        let history = store
            .list_turns(&session_id)?
            .into_iter()
            .map(|turn| HistoryTurn {
                user_text: turn.user_text,
                assistant_text: turn.assistant_text,
            })
            .collect::<Vec<_>>();
        let pcm = self.capture.pcm_for_asr();
        let user_text = text.map(str::trim).filter(|value| !value.is_empty());
        let turn = {
            let deps = CascadeTurnDeps {
                asr: probes.asr,
                llm: probes.llm,
                tts: probes.tts,
                embed: probes.embed,
                database,
                runtime: &self.runtime,
                sleep: &std::thread::sleep,
            };
            run_cascade_turn(
                &deps,
                CascadeTurnRequest {
                    config: &config,
                    credentials,
                    pcm: user_text.is_none().then_some(pcm.as_slice()),
                    sample_rate: ASR_SAMPLE_RATE,
                    user_text,
                    history: &history,
                },
                &self.cancel,
            )?
        };

        let turn_id = uuid::Uuid::new_v4().to_string();
        store.insert_turn(NewTurn {
            id: &turn_id,
            session_id: &session_id,
            turn_index: self.turn_index,
            user_text: &turn.user_text,
            assistant_text: &turn.assistant_text,
            materials_used: turn.materials_used,
        })?;
        if !turn.citations.is_empty() {
            let citations = turn
                .citations
                .iter()
                .map(|citation| NewCitation {
                    turn_id: &turn_id,
                    material_id: &citation.material_id,
                    chunk_id: &citation.chunk_id,
                    snippet: &citation.snippet,
                })
                .collect::<Vec<_>>();
            store.insert_citations(&citations)?;
        }
        store.append_event(
            &session_id,
            "transcript",
            &serde_json::json!({ "text": truncate(&turn.user_text) }).to_string(),
        )?;
        store.append_event(
            &session_id,
            "reply",
            &serde_json::json!({ "text": truncate(&turn.assistant_text) }).to_string(),
        )?;
        self.turn_index += 1;

        self.runtime.transition(SessionPhase::Speaking)?;
        persist_phase(&store, &session_id, SessionPhase::Speaking)?;
        if !turn.tts_pcm.is_empty() {
            self.sink.play_pcm(&turn.tts_pcm, 24_000);
        }
        if self.cancel.load(Ordering::SeqCst) {
            return Ok(Some(turn));
        }
        self.runtime.transition(SessionPhase::Listening)?;
        persist_phase(&store, &session_id, SessionPhase::Listening)?;
        Ok(Some(turn))
    }

    pub fn poll_sidecar(
        &mut self,
        database: &Database,
    ) -> Result<SidecarPoll, SessionServiceError> {
        match self.capture.poll_sidecar()? {
            SidecarPoll::Alive => Ok(SidecarPoll::Alive),
            SidecarPoll::Exited => match self.capture.restart_once() {
                Ok(()) => Ok(SidecarPoll::Alive),
                Err(error) => {
                    self.fail_session(database)?;
                    Err(error.into())
                }
            },
        }
    }

    fn has_active_session(&self) -> bool {
        self.session_id.is_some() && !is_terminal_phase(self.runtime.phase())
    }

    fn reset_runtime(&mut self) {
        self.runtime = SessionRuntime::new();
        self.session_id = None;
        self.turn_index = 0;
        self.cancel.store(false, Ordering::SeqCst);
        self.capture = AudioCapture::from_injected();
    }

    fn fail_session(&mut self, database: &Database) -> Result<(), SessionServiceError> {
        let Some(session_id) = self.session_id.clone() else {
            return Ok(());
        };
        if self.runtime.phase() != SessionPhase::Failed {
            self.runtime.transition(SessionPhase::Failed)?;
        }
        let store = SessionStore::new(database);
        store.finish(&session_id, "failed")?;
        store.append_event(&session_id, "status", &status_payload(SessionPhase::Failed))?;
        Ok(())
    }
}

fn persist_snapshot(
    store: &SessionStore<'_>,
    session_id: &str,
    config: &PublicConfig,
) -> Result<(), SessionServiceError> {
    let snapshot = build_snapshot(config);
    let provider_ids =
        serde_json::to_string(&snapshot.provider_ids).unwrap_or_else(|_| "[]".into());
    let model_ids = serde_json::to_string(&snapshot.model_ids).unwrap_or_else(|_| "[]".into());
    store.insert_snapshot(NewSnapshot {
        id: &uuid::Uuid::new_v4().to_string(),
        session_id,
        app_version: &snapshot.app_version,
        config_revision: &snapshot.config_revision,
        provider_ids: &provider_ids,
        model_ids: &model_ids,
        voice_route_id: &snapshot.voice_route_id,
        transport_mode: &snapshot.transport_mode,
        role_hash: &snapshot.role_hash,
        knowledge_fingerprint: &snapshot.knowledge_fingerprint,
    })?;
    Ok(())
}

fn persist_phase(
    store: &SessionStore<'_>,
    session_id: &str,
    phase: SessionPhase,
) -> Result<(), SessionServiceError> {
    store.set_status(session_id, phase_name(phase))?;
    store.append_event(session_id, "status", &status_payload(phase))?;
    Ok(())
}

fn status_payload(phase: SessionPhase) -> String {
    serde_json::json!({ "status": phase_name(phase) }).to_string()
}

fn phase_name(phase: SessionPhase) -> &'static str {
    match phase {
        SessionPhase::Idle => "idle",
        SessionPhase::Preparing => "preparing",
        SessionPhase::Listening => "listening",
        SessionPhase::Thinking => "thinking",
        SessionPhase::Speaking => "speaking",
        SessionPhase::Stopping => "stopping",
        SessionPhase::Completed => "completed",
        SessionPhase::Recovering => "recovering",
        SessionPhase::Blocked => "blocked",
        SessionPhase::Failed => "failed",
    }
}

fn mode_name(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::AiActive => "ai_active",
        AgentMode::OperatorSpeaking => "operator_speaking",
        AgentMode::Paused => "paused",
        AgentMode::Muted => "muted",
    }
}

fn is_terminal_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted")
}

fn is_terminal_phase(phase: SessionPhase) -> bool {
    matches!(phase, SessionPhase::Completed | SessionPhase::Failed)
}

fn with_default_voice(config: &PublicConfig) -> PublicConfig {
    let mut config = config.clone();
    let active_id = config.speech.active_voice_route_id.clone();
    if let Some(route) = config
        .speech
        .voice_routes
        .iter_mut()
        .find(|route| active_id.as_deref() == Some(route.id.as_str()) && route.active)
        && route.voice_id.as_deref().is_none_or(str::is_empty)
    {
        route.voice_id = Some("alloy".into());
    }
    config
}

fn truncate(text: &str) -> String {
    text.chars().take(160).collect()
}

#[cfg(test)]
mod tests {
    use super::{SessionProbes, SessionService, SessionServiceError, SessionStartOutcome};
    use crate::{
        app_state::{AppPaths, AppState},
        audio::{RecordingSink, SidecarPoll},
        config::PublicConfig,
        database::Database,
        providers::{
            CascadeError, ChatMessage, ChatModel, EmbeddingError, EmbeddingProbe, ProviderEndpoint,
            SpeechToText, TextToSpeech,
        },
        runtime::{AgentMode, CascadeCredentials, SessionPhase, test_support::ready_public_config},
        secrets::MemorySecretStore,
        sessions::{NewSession, SessionStore},
    };
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    };

    struct ScriptedAsr {
        text: String,
        calls: AtomicU32,
    }

    impl ScriptedAsr {
        fn ok(text: &str) -> Self {
            Self {
                text: text.into(),
                calls: AtomicU32::new(0),
            }
        }
    }

    impl SpeechToText for ScriptedAsr {
        fn transcribe(
            &self,
            _: &ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: &[u8],
            _: u32,
        ) -> Result<String, CascadeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.text.clone())
        }
    }

    struct ScriptedLlm {
        reply: String,
        calls: AtomicU32,
    }

    impl ScriptedLlm {
        fn ok(reply: &str) -> Self {
            Self {
                reply: reply.into(),
                calls: AtomicU32::new(0),
            }
        }
    }

    impl ChatModel for ScriptedLlm {
        fn complete(
            &self,
            _: &ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: &[ChatMessage],
        ) -> Result<String, CascadeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.reply.clone())
        }
    }

    struct ScriptedTts {
        pcm: Vec<u8>,
        voices: Mutex<Vec<String>>,
        calls: AtomicU32,
    }

    impl ScriptedTts {
        fn ok(pcm: &[u8]) -> Self {
            Self {
                pcm: pcm.to_vec(),
                voices: Mutex::new(Vec::new()),
                calls: AtomicU32::new(0),
            }
        }
    }

    impl TextToSpeech for ScriptedTts {
        fn synthesize(
            &self,
            _: &ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            voice_id: &str,
            _: &str,
        ) -> Result<Vec<u8>, CascadeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.voices
                .lock()
                .expect("tts voices")
                .push(voice_id.to_owned());
            Ok(self.pcm.clone())
        }
    }

    struct UnusedEmbed;

    impl EmbeddingProbe for UnusedEmbed {
        fn embed(
            &self,
            _: &ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: u32,
            _: &str,
        ) -> Result<Vec<f32>, EmbeddingError> {
            Err(EmbeddingError::RequestFailed)
        }
    }

    fn opened() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("app.sqlite3")).unwrap();
        database.migrate().unwrap();
        (directory, database)
    }

    fn credentials() -> CascadeCredentials<'static> {
        CascadeCredentials {
            asr: Some("asr"),
            llm: Some("llm"),
            tts: Some("tts"),
            embed: Some("emb"),
        }
    }

    fn start_ready(service: &mut SessionService, database: &Database) -> String {
        match service
            .start(database, &ready_public_config(), true)
            .unwrap()
        {
            SessionStartOutcome::Started { session } => session.id,
            SessionStartOutcome::Blocked { issues } => {
                panic!("expected start, blocked {issues:?}")
            }
        }
    }

    fn start_ready_sink(
        service: &mut SessionService<RecordingSink>,
        database: &Database,
        config: &PublicConfig,
    ) -> String {
        match service.start(database, config, true).unwrap() {
            SessionStartOutcome::Started { session } => session.id,
            SessionStartOutcome::Blocked { issues } => {
                panic!("expected start, blocked {issues:?}")
            }
        }
    }

    #[test]
    fn start_returns_blocked_issues_and_does_not_insert_session() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let empty = crate::runtime::test_support::empty_public_config();

        let outcome = service.start(&database, &empty, false).unwrap();
        match outcome {
            SessionStartOutcome::Blocked { issues } => {
                assert!(issues.len() >= 2, "{issues:?}");
                assert!(
                    issues
                        .iter()
                        .any(|issue| issue.code == "SESSION_ROUTE_REQUIRED")
                );
            }
            SessionStartOutcome::Started { session } => {
                panic!("started despite preflight {}", session.id)
            }
        }
        assert_eq!(service.phase(), SessionPhase::Idle);
        assert!(SessionStore::new(&database).list().unwrap().is_empty());
    }

    #[test]
    fn start_inserts_session_snapshot_and_reaches_listening() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_ready(&mut service, &database);

        assert_eq!(service.phase(), SessionPhase::Listening);
        let store = SessionStore::new(&database);
        let row = store.get(&id).unwrap().expect("session");
        assert_eq!(row.status, "listening");
        assert_eq!(row.transport_mode, "direct");
        assert_eq!(row.role_profile_id, "role-1");
        assert_eq!(row.voice_route_id, "route-1");
        assert!(row.started_at.is_some());
        assert!(row.finished_at.is_none());
        let snapshots = store.list_snapshots(&id).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].voice_route_id, "route-1");
        assert_eq!(snapshots[0].transport_mode, "direct");
        assert!(!snapshots[0].role_hash.is_empty());
        assert!(!snapshots[0].provider_ids.contains("sk-"));
    }

    #[test]
    fn second_start_while_active_returns_already_active() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        start_ready(&mut service, &database);

        let error = service
            .start(&database, &ready_public_config(), true)
            .expect_err("second start");
        assert_eq!(error.code(), "SESSION_ALREADY_ACTIVE");
        assert!(matches!(error, SessionServiceError::AlreadyActive));
        assert_eq!(SessionStore::new(&database).list().unwrap().len(), 1);
        assert_eq!(service.phase(), SessionPhase::Listening);
    }

    #[test]
    fn finalize_text_persists_turn_and_returns_to_listening() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_ready(&mut service, &database);
        let asr = ScriptedAsr::ok("ignored");
        let llm = ScriptedLlm::ok("助手回复");
        let tts = ScriptedTts::ok(&[0x01, 0x02]);
        let embed = UnusedEmbed;
        let probes = SessionProbes {
            asr: &asr,
            llm: &llm,
            tts: &tts,
            embed: &embed,
        };

        let turn = service
            .finalize_utterance(
                &database,
                &ready_public_config(),
                &probes,
                credentials(),
                Some("你好"),
            )
            .unwrap()
            .expect("turn");

        assert_eq!(turn.user_text, "你好");
        assert_eq!(turn.assistant_text, "助手回复");
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
        assert_eq!(asr.calls.load(Ordering::SeqCst), 0);
        assert_eq!(service.phase(), SessionPhase::Listening);

        let stored = SessionStore::new(&database).list_turns(&id).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].user_text, "你好");
        assert_eq!(stored[0].assistant_text, "助手回复");
        assert!(!stored[0].materials_used);
    }

    #[test]
    fn finalize_injected_pcm_uses_asr() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        start_ready(&mut service, &database);
        service.push_pcm(&[0x10, 0x00, 0x20, 0x00, 0x30, 0x00]);
        let asr = ScriptedAsr::ok("从音频来");
        let llm = ScriptedLlm::ok("收到");
        let tts = ScriptedTts::ok(&[0x03, 0x04]);
        let embed = UnusedEmbed;
        let probes = SessionProbes {
            asr: &asr,
            llm: &llm,
            tts: &tts,
            embed: &embed,
        };

        let turn = service
            .finalize_utterance(
                &database,
                &ready_public_config(),
                &probes,
                credentials(),
                None,
            )
            .unwrap()
            .expect("turn");

        assert_eq!(turn.user_text, "从音频来");
        assert_eq!(asr.calls.load(Ordering::SeqCst), 1);
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
        assert_eq!(service.phase(), SessionPhase::Listening);
    }

    #[test]
    fn takeover_cancels_sink_and_skips_llm() {
        let (_directory, database) = opened();
        let mut service = SessionService::with_sink(RecordingSink::default());
        let id = start_ready_sink(&mut service, &database, &ready_public_config());
        service
            .set_mode(&database, AgentMode::OperatorSpeaking)
            .unwrap();

        assert_eq!(service.mode(), AgentMode::OperatorSpeaking);
        assert!(!service.runtime_can_answer());
        assert!(service.sink().cancelled());

        let asr = ScriptedAsr::ok("ignored");
        let llm = ScriptedLlm::ok("should-not-run");
        let tts = ScriptedTts::ok(&[0x09]);
        let embed = UnusedEmbed;
        let probes = SessionProbes {
            asr: &asr,
            llm: &llm,
            tts: &tts,
            embed: &embed,
        };
        let turn = service
            .finalize_utterance(
                &database,
                &ready_public_config(),
                &probes,
                credentials(),
                Some("接管后提问"),
            )
            .unwrap();

        assert!(turn.is_none());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 0);
        assert!(
            SessionStore::new(&database)
                .list_turns(&id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(service.phase(), SessionPhase::Listening);
    }

    #[test]
    fn stop_marks_completed_and_sets_finished_at() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_ready(&mut service, &database);

        let row = service.stop(&database).unwrap();
        assert_eq!(row.status, "completed");
        assert!(row.finished_at.is_some());
        assert_eq!(service.phase(), SessionPhase::Completed);

        let stored = SessionStore::new(&database).get(&id).unwrap().unwrap();
        assert_eq!(stored.status, "completed");
        assert!(stored.finished_at.is_some());
    }

    #[test]
    fn start_after_stop_opens_a_new_session() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let first = start_ready(&mut service, &database);
        service.stop(&database).unwrap();
        let second = start_ready(&mut service, &database);
        assert_ne!(first, second);
        assert_eq!(service.phase(), SessionPhase::Listening);
        assert_eq!(SessionStore::new(&database).list().unwrap().len(), 2);
    }

    #[test]
    fn empty_voice_id_defaults_to_alloy() {
        let (_directory, database) = opened();
        let mut config = ready_public_config();
        config.speech.voice_routes[0].voice_id = Some(String::new());
        let mut service = SessionService::new();
        match service.start(&database, &config, true).unwrap() {
            SessionStartOutcome::Started { .. } => {}
            SessionStartOutcome::Blocked { issues } => panic!("blocked {issues:?}"),
        }
        let asr = ScriptedAsr::ok("hi");
        let llm = ScriptedLlm::ok("ok");
        let tts = ScriptedTts::ok(&[0x11, 0x22]);
        let embed = UnusedEmbed;
        let probes = SessionProbes {
            asr: &asr,
            llm: &llm,
            tts: &tts,
            embed: &embed,
        };

        service
            .finalize_utterance(&database, &config, &probes, credentials(), Some("hi"))
            .unwrap()
            .expect("turn");
        assert_eq!(
            tts.voices.lock().expect("voices").as_slice(),
            ["alloy".to_string()]
        );
    }

    #[test]
    fn sidecar_second_crash_fails_session() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_ready(&mut service, &database);

        service.capture().mark_sidecar_exited();
        assert_eq!(service.poll_sidecar(&database).unwrap(), SidecarPoll::Alive);
        service.capture().mark_sidecar_exited();
        let error = service.poll_sidecar(&database).expect_err("second crash");
        assert_eq!(error.code(), "SESSION_SIDECAR_FAILED");
        assert_eq!(service.phase(), SessionPhase::Failed);
        let row = SessionStore::new(&database).get(&id).unwrap().unwrap();
        assert_eq!(row.status, "failed");
        assert!(row.finished_at.is_some());
    }

    #[test]
    fn app_state_open_marks_leftover_sessions_interrupted_without_resume() {
        let directory = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            data_directory: directory.path().join("data"),
            logs_directory: directory.path().join("logs"),
            config_path: directory.path().join("config.json"),
        };
        std::fs::write(&paths.config_path, r#"{"configVersion":1}"#).unwrap();
        std::fs::create_dir_all(&paths.data_directory).unwrap();
        let db_path = paths.data_directory.join("app.sqlite3");
        {
            let database = Database::open(&db_path).unwrap();
            database.migrate().unwrap();
            SessionStore::new(&database)
                .insert_session(NewSession {
                    id: "leftover",
                    status: "listening",
                    role_profile_id: "role-1",
                    voice_route_id: "route-1",
                    transport_mode: "direct",
                })
                .unwrap();
        }

        let state = AppState::initialize(paths, Arc::new(MemorySecretStore::default())).unwrap();
        let guard = state.database.lock().expect("db");
        let database = guard.as_ref().expect("opened");
        let leftover = SessionStore::new(database)
            .get("leftover")
            .unwrap()
            .expect("row");
        assert_eq!(leftover.status, "interrupted");
        assert!(leftover.finished_at.is_some());

        let service = SessionService::new();
        assert_eq!(service.phase(), SessionPhase::Idle);
        assert_eq!(
            service.capture().poll_sidecar().unwrap(),
            SidecarPoll::Alive
        );
        assert_eq!(service.capture().snapshot_48k().len(), 0);
        assert!(service.session_id().is_none());
    }
}
