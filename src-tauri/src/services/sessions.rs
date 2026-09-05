use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU8, Ordering},
};

use crate::{
    audio::{ASR_SAMPLE_RATE, AudioCapture, AudioError, NoopSink, PlaybackSink, SidecarPoll},
    config::{PublicConfig, VoiceRouteMode},
    database::{Database, DatabaseError},
    providers::{
        CascadeError, CascadeStage, ChatMessage, ChatModel, EmbeddingProbe, ProviderEndpoint,
        RealtimeError, RealtimeModel, RealtimeTextRequest, SpeechToText, TextToSpeech,
    },
    runtime::{
        AgentCommand, AgentCommandAction, AgentCommandError, AgentCommandOutcome, AgentMode,
        CascadeCredentials, CascadeTurn, CascadeTurnDeps, CascadeTurnRequest, HistoryTurn,
        PreflightIssue, RuntimeError, SessionPhase, SessionRuntime, active_role_profile,
        active_voice_route, assert_expected_revision, build_snapshot, cascade::retrieve,
        execute_agent_command, preflight, run_cascade_turn,
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
    Realtime(RealtimeError),
    Audio(AudioError),
    Database(DatabaseError),
}

impl SessionServiceError {
    pub fn code(&self) -> &str {
        match self {
            Self::AlreadyActive => "SESSION_ALREADY_ACTIVE",
            Self::NotFound => "SESSION_NOT_FOUND",
            Self::StateInvalid => "SESSION_STATE_INVALID",
            Self::SidecarFailed => "SESSION_SIDECAR_FAILED",
            Self::Cascade(error) => error.code(),
            Self::Realtime(error) => error.code(),
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

impl From<RealtimeError> for SessionServiceError {
    fn from(error: RealtimeError) -> Self {
        Self::Realtime(error)
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
    pub realtime: &'a dyn RealtimeModel,
}

/// Flags stop / takeover can set without waiting for `SessionService`.
pub struct SessionControl {
    cancel: AtomicBool,
    stop_requested: AtomicBool,
    stop_tts: AtomicBool,
    mode: AtomicU8,
    session_id: Mutex<Option<String>>,
}

impl SessionControl {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cancel: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
            stop_tts: AtomicBool::new(false),
            mode: AtomicU8::new(mode_u8(AgentMode::AiActive)),
            session_id: Mutex::new(None),
        })
    }

    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        self.cancel.store(true, Ordering::SeqCst);
        self.stop_tts.store(true, Ordering::SeqCst);
    }

    pub fn set_mode(&self, mode: AgentMode) {
        self.mode.store(mode_u8(mode), Ordering::SeqCst);
        if mode == AgentMode::AiActive {
            self.stop_tts.store(false, Ordering::SeqCst);
        } else {
            self.stop_tts.store(true, Ordering::SeqCst);
            self.cancel.store(true, Ordering::SeqCst);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub fn stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }

    pub fn mode(&self) -> AgentMode {
        mode_from_u8(self.mode.load(Ordering::SeqCst))
    }

    pub fn session_id(&self) -> Option<String> {
        self.session_id.lock().ok().and_then(|guard| guard.clone())
    }

    pub fn take_stop_tts(&self) -> bool {
        self.stop_tts.swap(false, Ordering::SeqCst)
    }

    fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }

    fn clear_cancel(&self) {
        self.cancel.store(false, Ordering::SeqCst);
    }

    fn set_session_id(&self, session_id: Option<String>) {
        if let Ok(mut guard) = self.session_id.lock() {
            *guard = session_id;
        }
    }

    fn reset(&self) {
        self.cancel.store(false, Ordering::SeqCst);
        self.stop_requested.store(false, Ordering::SeqCst);
        self.stop_tts.store(false, Ordering::SeqCst);
        self.mode
            .store(mode_u8(AgentMode::AiActive), Ordering::SeqCst);
        self.set_session_id(None);
    }
}

pub struct SessionService<S: PlaybackSink = NoopSink> {
    runtime: SessionRuntime,
    session_id: Option<String>,
    capture: AudioCapture,
    sink: S,
    control: Arc<SessionControl>,
    turn_index: i64,
    revision: u64,
    unused_materials: bool,
    last_error_code: Option<String>,
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
            control: SessionControl::new(),
            turn_index: 0,
            revision: 0,
            unused_materials: false,
            last_error_code: None,
        }
    }

    pub fn control(&self) -> Arc<SessionControl> {
        Arc::clone(&self.control)
    }

    pub fn phase(&self) -> SessionPhase {
        self.runtime.phase()
    }

    pub fn mode(&self) -> AgentMode {
        self.control.mode()
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

    pub fn unused_materials(&self) -> bool {
        self.unused_materials
    }

    pub fn last_error_code(&self) -> Option<&str> {
        self.last_error_code.as_deref()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn reset(&mut self) {
        self.reset_runtime();
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
        self.unused_materials = false;
        self.last_error_code = None;
        let session_id = uuid::Uuid::new_v4().to_string();
        self.control.set_session_id(Some(session_id.clone()));
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
        self.control.request_stop();
        self.sink.cancel();
        self.finish_stop(database)
    }

    pub fn set_mode(
        &mut self,
        database: &Database,
        mode: AgentMode,
    ) -> Result<AgentMode, SessionServiceError> {
        self.control.set_mode(mode);
        self.runtime.set_mode(mode);
        if self.control.take_stop_tts() || self.runtime.take_stop_tts() {
            self.sink.cancel();
        }
        if let Some(session_id) = &self.session_id {
            SessionStore::new(database).append_event(
                session_id,
                "takeover",
                &serde_json::json!({ "mode": mode_name(mode) }).to_string(),
            )?;
        }
        Ok(self.control.mode())
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
        self.runtime.set_mode(self.control.mode());
        if self.control.take_stop_tts() {
            self.sink.cancel();
        }
        if !self.runtime.can_answer() {
            return Ok(None);
        }
        if self.control.stop_requested() {
            self.finish_stop(database)?;
            return Ok(None);
        }
        self.control.clear_cancel();
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
        let deps = CascadeTurnDeps {
            asr: probes.asr,
            llm: probes.llm,
            tts: probes.tts,
            embed: probes.embed,
            database,
            runtime: &self.runtime,
            sleep: &std::thread::sleep,
        };
        let request = CascadeTurnRequest {
            config: &config,
            credentials,
            pcm: user_text.is_none().then_some(pcm.as_slice()),
            sample_rate: ASR_SAMPLE_RATE,
            user_text,
            history: &history,
        };
        let e2e_route =
            active_voice_route(&config).is_some_and(|route| route.mode == VoiceRouteMode::E2e);
        let turn = if e2e_route {
            match run_e2e_turn(
                probes.realtime,
                &deps,
                &request,
                &pcm,
                self.control.cancel_flag(),
            ) {
                Ok(turn) => turn,
                Err(error) => {
                    return self.recover_from_realtime_error(database, &session_id, error);
                }
            }
        } else {
            match run_cascade_turn(&deps, request, self.control.cancel_flag()) {
                Ok(turn) => turn,
                Err(error) => {
                    return self.recover_from_cascade_error(database, &session_id, error);
                }
            }
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
        self.revision += 1;
        self.unused_materials = !turn.materials_used;
        self.last_error_code = None;

        self.runtime.transition(SessionPhase::Speaking)?;
        persist_phase(&store, &session_id, SessionPhase::Speaking)?;
        if self.control.take_stop_tts() || self.control.is_cancelled() {
            self.sink.cancel();
        } else if !turn.tts_pcm.is_empty() {
            self.sink.play_pcm(&turn.tts_pcm, 24_000);
        }
        if self.control.stop_requested() {
            self.finish_stop(database)?;
            return Ok(Some(turn));
        }
        if self.control.is_cancelled() {
            self.return_to_listening(database, &session_id)?;
            return Ok(Some(turn));
        }
        self.runtime.transition(SessionPhase::Listening)?;
        persist_phase(&store, &session_id, SessionPhase::Listening)?;
        Ok(Some(turn))
    }

    pub fn execute_command(
        &mut self,
        database: &Database,
        config: &PublicConfig,
        probes: &SessionProbes<'_>,
        credentials: CascadeCredentials<'_>,
        command: AgentCommand,
    ) -> Result<AgentCommandOutcome, SessionServiceError> {
        self.poll_sidecar(database)?;
        self.runtime.set_mode(self.control.mode());
        if self.control.take_stop_tts() {
            self.sink.cancel();
        }
        let session_id = self
            .session_id
            .clone()
            .ok_or(SessionServiceError::NotFound)?;
        if command.action == AgentCommandAction::SetMode {
            let mode = command.mode.ok_or(SessionServiceError::StateInvalid)?;
            self.set_mode(database, mode)?;
            return Ok(AgentCommandOutcome::ok(
                command.command_id,
                command.action,
                [("mode", serde_json::json!(mode.as_str()))]
                    .into_iter()
                    .map(|(key, value)| (key.to_owned(), value))
                    .collect(),
            ));
        }
        if matches!(
            command.action,
            AgentCommandAction::Retry | AgentCommandAction::Correct
        ) && let Err(error) = assert_expected_revision(command.expected_revision, self.revision)
        {
            return Ok(AgentCommandOutcome::fail(
                command.command_id,
                command.action,
                error.code(),
            ));
        }
        let store = SessionStore::new(database);
        let turns = store.list_turns(&session_id)?;
        if matches!(
            command.action,
            AgentCommandAction::Retry | AgentCommandAction::Correct
        ) && turns.is_empty()
        {
            return Ok(AgentCommandOutcome::fail(
                command.command_id,
                command.action,
                AgentCommandError::Invalid.code(),
            ));
        }
        let config = with_default_voice(config);
        let e2e_route = active_voice_route(&config)
            .is_some_and(|route| route.mode == crate::config::VoiceRouteMode::E2e);
        let history = turns
            .iter()
            .map(|turn| HistoryTurn {
                user_text: turn.user_text.clone(),
                assistant_text: turn.assistant_text.clone(),
            })
            .collect::<Vec<_>>();
        let last_turn_id = turns.last().map(|turn| turn.id.clone());
        let cached_pcm = std::cell::RefCell::new(Option::<Vec<u8>>::None);
        let last_error = std::cell::RefCell::new(Option::<SessionServiceError>::None);
        let include_audio = command.action != AgentCommandAction::Report;
        let cancel = self.control.cancel_flag();
        let generate = |prompt: &str| match generate_command_text(
            CommandGenerate {
                probes,
                config: &config,
                credentials,
                history: &history,
                prompt,
                e2e_route,
                include_audio,
            },
            cancel,
        ) {
            Ok((text, pcm)) => {
                if !pcm.is_empty() {
                    *cached_pcm.borrow_mut() = Some(pcm);
                }
                Ok(text)
            }
            Err(error) => {
                *last_error.borrow_mut() = Some(error);
                Err(AgentCommandError::Invalid)
            }
        };
        let speak = |text: &str| match speak_command_text(
            probes,
            &config,
            credentials,
            text,
            e2e_route,
            cached_pcm.borrow_mut().take(),
            cancel,
        ) {
            Ok(pcm) => {
                if self.control.take_stop_tts() || self.control.is_cancelled() {
                    self.sink.cancel();
                } else if !pcm.is_empty() {
                    self.sink.play_pcm(&pcm, 24_000);
                }
                Ok(())
            }
            Err(error) => {
                *last_error.borrow_mut() = Some(error);
                Err(AgentCommandError::Invalid)
            }
        };
        match execute_agent_command(&command, generate, speak) {
            Ok(result) => {
                if matches!(
                    command.action,
                    AgentCommandAction::Retry | AgentCommandAction::Correct
                ) {
                    let replacement = if command.action == AgentCommandAction::Retry {
                        result
                            .get("question")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                    } else {
                        command.answer.as_str()
                    };
                    if let Some(turn_id) = last_turn_id.as_deref() {
                        store.update_assistant_text(turn_id, replacement)?;
                        store.append_event(
                            &session_id,
                            "reply",
                            &serde_json::json!({ "text": truncate(replacement) }).to_string(),
                        )?;
                    }
                    self.revision += 1;
                }
                self.last_error_code = None;
                Ok(AgentCommandOutcome::ok(
                    command.command_id,
                    command.action,
                    result,
                ))
            }
            Err(error) => {
                if let Some(service_error) = last_error.into_inner() {
                    self.last_error_code = Some(service_error.code().to_owned());
                    return Err(service_error);
                }
                Ok(AgentCommandOutcome::fail(
                    command.command_id,
                    command.action,
                    error.code(),
                ))
            }
        }
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
                    self.last_error_code = Some(error.code().to_owned());
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
        self.revision = 0;
        self.unused_materials = false;
        self.last_error_code = None;
        self.control.reset();
        self.capture = AudioCapture::from_injected();
    }

    fn recover_from_cascade_error(
        &mut self,
        database: &Database,
        session_id: &str,
        error: CascadeError,
    ) -> Result<Option<CascadeTurn>, SessionServiceError> {
        self.last_error_code = Some(error.code().to_owned());
        if self.control.take_stop_tts() {
            self.sink.cancel();
        }
        if self.control.stop_requested() {
            self.finish_stop(database)?;
            return Err(error.into());
        }
        if is_fatal_cascade(&error) {
            self.fail_session(database)?;
            return Err(error.into());
        }
        self.return_to_listening(database, session_id)?;
        Err(error.into())
    }

    fn recover_from_realtime_error(
        &mut self,
        database: &Database,
        session_id: &str,
        error: RealtimeError,
    ) -> Result<Option<CascadeTurn>, SessionServiceError> {
        self.last_error_code = Some(error.code().to_owned());
        if self.control.take_stop_tts() {
            self.sink.cancel();
        }
        if self.control.stop_requested() {
            self.finish_stop(database)?;
            return Err(error.into());
        }
        if is_fatal_realtime(&error) {
            self.fail_session(database)?;
            return Err(error.into());
        }
        self.return_to_listening(database, session_id)?;
        Err(error.into())
    }

    fn return_to_listening(
        &mut self,
        database: &Database,
        session_id: &str,
    ) -> Result<(), SessionServiceError> {
        if self.runtime.phase() == SessionPhase::Listening {
            return Ok(());
        }
        self.runtime.transition(SessionPhase::Listening)?;
        persist_phase(
            &SessionStore::new(database),
            session_id,
            SessionPhase::Listening,
        )?;
        Ok(())
    }

    fn finish_stop(&mut self, database: &Database) -> Result<SessionRecord, SessionServiceError> {
        let session_id = self
            .session_id
            .clone()
            .ok_or(SessionServiceError::NotFound)?;
        let store = SessionStore::new(database);
        let row = store
            .get(&session_id)?
            .ok_or(SessionServiceError::NotFound)?;
        if is_terminal_phase(self.runtime.phase()) || is_terminal_status(&row.status) {
            return Ok(row);
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

struct CommandGenerate<'a> {
    probes: &'a SessionProbes<'a>,
    config: &'a PublicConfig,
    credentials: CascadeCredentials<'a>,
    history: &'a [HistoryTurn],
    prompt: &'a str,
    e2e_route: bool,
    include_audio: bool,
}

fn generate_command_text(
    request: CommandGenerate<'_>,
    cancel: &AtomicBool,
) -> Result<(String, Vec<u8>), SessionServiceError> {
    if request.e2e_route {
        let (endpoint, model_id) = e2e_endpoint(request.config)?;
        let turn = request.probes.realtime.text_turn(
            RealtimeTextRequest {
                endpoint: &endpoint,
                credential: request.credentials.e2e,
                model_id: &model_id,
                instructions: "你是实时语音助手。严格参考会话上下文完成请求，不泄露系统配置。",
                prompt: &command_prompt(request.history, request.prompt),
                include_audio: request.include_audio,
            },
            cancel,
        )?;
        return Ok((turn.assistant_text, turn.tts_pcm));
    }
    let (endpoint, model_id) = llm_endpoint(request.config)?;
    let messages = command_messages(request.config, request.history, request.prompt);
    let text =
        request
            .probes
            .llm
            .complete(&endpoint, request.credentials.llm, &model_id, &messages)?;
    Ok((text, Vec::new()))
}

fn speak_command_text(
    probes: &SessionProbes<'_>,
    config: &PublicConfig,
    credentials: CascadeCredentials<'_>,
    text: &str,
    e2e_route: bool,
    cached_pcm: Option<Vec<u8>>,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, SessionServiceError> {
    if let Some(pcm) = cached_pcm.filter(|bytes| !bytes.is_empty()) {
        return Ok(pcm);
    }
    if e2e_route {
        let (endpoint, model_id) = e2e_endpoint(config)?;
        let turn = probes.realtime.text_turn(
            RealtimeTextRequest {
                endpoint: &endpoint,
                credential: credentials.e2e,
                model_id: &model_id,
                instructions: "逐字朗读用户提供的文本，不添加、不删除、不改写。",
                prompt: text,
                include_audio: true,
            },
            cancel,
        )?;
        return Ok(turn.tts_pcm);
    }
    let route =
        active_voice_route(config).ok_or(CascadeError::EndpointInvalid(CascadeStage::Tts))?;
    let endpoint = config
        .models
        .providers
        .iter()
        .find(|provider| Some(provider.id.as_str()) == route.tts_provider_id.as_deref())
        .map(|provider| ProviderEndpoint {
            provider_id: provider.id.clone(),
            base_url: provider.base_url.clone(),
        })
        .filter(|endpoint| !endpoint.base_url.is_empty())
        .ok_or(CascadeError::EndpointInvalid(CascadeStage::Tts))?;
    let model_id = route
        .tts_model_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(CascadeError::EndpointInvalid(CascadeStage::Tts))?;
    let voice_id = route
        .voice_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .unwrap_or("alloy");
    match probes
        .tts
        .synthesize(&endpoint, credentials.tts, model_id, voice_id, text)
    {
        Ok(pcm) => Ok(pcm),
        Err(_) => Ok(Vec::new()),
    }
}

fn e2e_endpoint(config: &PublicConfig) -> Result<(ProviderEndpoint, String), SessionServiceError> {
    let route = active_voice_route(config).ok_or(RealtimeError::UrlInvalid)?;
    let provider_id = route
        .e2e_provider_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(RealtimeError::UrlInvalid)?;
    let model_id = route
        .e2e_model_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(RealtimeError::UrlInvalid)?
        .to_owned();
    let endpoint = config
        .models
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .map(|provider| ProviderEndpoint {
            provider_id: provider.id.clone(),
            base_url: provider.base_url.clone(),
        })
        .filter(|endpoint| !endpoint.base_url.is_empty())
        .ok_or(RealtimeError::UrlInvalid)?;
    Ok((endpoint, model_id))
}

fn llm_endpoint(config: &PublicConfig) -> Result<(ProviderEndpoint, String), SessionServiceError> {
    let route =
        active_voice_route(config).ok_or(CascadeError::EndpointInvalid(CascadeStage::Llm))?;
    let provider_id = route
        .llm_provider_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(CascadeError::EndpointInvalid(CascadeStage::Llm))?;
    let model_id = route
        .llm_model_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(CascadeError::EndpointInvalid(CascadeStage::Llm))?
        .to_owned();
    let endpoint = config
        .models
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .map(|provider| ProviderEndpoint {
            provider_id: provider.id.clone(),
            base_url: provider.base_url.clone(),
        })
        .filter(|endpoint| !endpoint.base_url.is_empty())
        .ok_or(CascadeError::EndpointInvalid(CascadeStage::Llm))?;
    Ok((endpoint, model_id))
}

fn command_messages(
    config: &PublicConfig,
    history: &[HistoryTurn],
    prompt: &str,
) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    if let Some(role) = active_role_profile(config) {
        let mut system = role.system_prompt.clone();
        if !role.style_instructions.is_empty() {
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(&role.style_instructions);
        }
        if !system.is_empty() {
            messages.push(ChatMessage {
                role: "system".into(),
                content: system,
            });
        }
    }
    for turn in history
        .iter()
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        messages.push(ChatMessage {
            role: "user".into(),
            content: turn.user_text.clone(),
        });
        messages.push(ChatMessage {
            role: "assistant".into(),
            content: turn.assistant_text.clone(),
        });
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: prompt.to_owned(),
    });
    messages
}

fn command_prompt(history: &[HistoryTurn], prompt: &str) -> String {
    let mut context = String::new();
    for turn in history
        .iter()
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        context.push_str("用户：");
        context.push_str(&turn.user_text);
        context.push('\n');
        context.push_str("助手：");
        context.push_str(&turn.assistant_text);
        context.push('\n');
    }
    format!("会话上下文：{context}\n任务：{prompt}")
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
    store.set_status(session_id, phase.as_str())?;
    store.append_event(session_id, "status", &status_payload(phase))?;
    Ok(())
}

fn status_payload(phase: SessionPhase) -> String {
    serde_json::json!({ "status": phase.as_str() }).to_string()
}

fn mode_name(mode: AgentMode) -> &'static str {
    mode.as_str()
}

fn mode_u8(mode: AgentMode) -> u8 {
    match mode {
        AgentMode::AiActive => 0,
        AgentMode::OperatorSpeaking => 1,
        AgentMode::Paused => 2,
        AgentMode::Muted => 3,
    }
}

fn mode_from_u8(value: u8) -> AgentMode {
    match value {
        1 => AgentMode::OperatorSpeaking,
        2 => AgentMode::Paused,
        3 => AgentMode::Muted,
        _ => AgentMode::AiActive,
    }
}

fn is_fatal_cascade(error: &CascadeError) -> bool {
    matches!(
        error,
        CascadeError::Unauthorized(_) | CascadeError::EndpointInvalid(_)
    )
}

fn is_fatal_realtime(error: &RealtimeError) -> bool {
    matches!(
        error,
        RealtimeError::Unauthorized | RealtimeError::UrlInvalid
    )
}

fn run_e2e_turn(
    realtime: &dyn RealtimeModel,
    deps: &CascadeTurnDeps<'_>,
    request: &CascadeTurnRequest<'_>,
    pcm: &[u8],
    cancel: &AtomicBool,
) -> Result<CascadeTurn, RealtimeError> {
    if cancel.load(Ordering::SeqCst) {
        return Err(RealtimeError::Cancelled);
    }
    let route = active_voice_route(request.config).ok_or(RealtimeError::UrlInvalid)?;
    let provider_id = route
        .e2e_provider_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(RealtimeError::UrlInvalid)?;
    let model_id = route
        .e2e_model_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(RealtimeError::UrlInvalid)?;
    let endpoint = request
        .config
        .models
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .map(|provider| ProviderEndpoint {
            provider_id: provider.id.clone(),
            base_url: provider.base_url.clone(),
        })
        .filter(|endpoint| !endpoint.base_url.is_empty())
        .ok_or(RealtimeError::UrlInvalid)?;
    let turn = realtime.transcribe_turn(
        &endpoint,
        request.credentials.e2e,
        model_id,
        pcm,
        request.sample_rate,
        cancel,
    )?;
    if cancel.load(Ordering::SeqCst) {
        return Err(RealtimeError::Cancelled);
    }
    let citations = retrieve(deps, request, &turn.user_text);
    if cancel.load(Ordering::SeqCst) {
        return Err(RealtimeError::Cancelled);
    }
    Ok(CascadeTurn {
        user_text: turn.user_text,
        assistant_text: turn.assistant_text,
        tts_pcm: turn.tts_pcm,
        materials_used: !citations.is_empty(),
        citations,
        error_code: None,
    })
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
            RealtimeError, RealtimeModel, RealtimeTextRequest, RealtimeTurn, SpeechToText,
            TextToSpeech,
        },
        runtime::{
            AgentMode, CascadeCredentials, SessionPhase,
            test_support::{ready_e2e_public_config, ready_public_config},
        },
        secrets::MemorySecretStore,
        sessions::{NewSession, SessionStore},
    };
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
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

    struct FailingLlm {
        error: CascadeError,
        calls: AtomicU32,
    }

    impl FailingLlm {
        fn new(error: CascadeError) -> Self {
            Self {
                error,
                calls: AtomicU32::new(0),
            }
        }
    }

    impl ChatModel for FailingLlm {
        fn complete(
            &self,
            _: &ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: &[ChatMessage],
        ) -> Result<String, CascadeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(self.error)
        }
    }

    struct GateLlm {
        reply: String,
        entered: Arc<std::sync::atomic::AtomicBool>,
        proceed: Arc<std::sync::atomic::AtomicBool>,
        calls: AtomicU32,
    }

    impl ChatModel for GateLlm {
        fn complete(
            &self,
            _: &ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: &[ChatMessage],
        ) -> Result<String, CascadeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.entered.store(true, Ordering::SeqCst);
            while !self.proceed.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
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

    struct UnusedRealtime;

    impl RealtimeModel for UnusedRealtime {
        fn transcribe_turn(
            &self,
            _: &ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: &[u8],
            _: u32,
            _: &AtomicBool,
        ) -> Result<RealtimeTurn, RealtimeError> {
            panic!("cascaded turn must not call Realtime")
        }
    }

    struct FakeRealtime {
        user_text: String,
        assistant_text: String,
        tts_pcm: Vec<u8>,
        error: Mutex<Option<RealtimeError>>,
        cancel_after: bool,
        calls: AtomicU32,
        text_calls: AtomicU32,
        pcm: Mutex<Vec<u8>>,
        model_id: Mutex<Option<String>>,
    }

    impl FakeRealtime {
        fn ok(user_text: &str, assistant_text: &str, pcm: &[u8]) -> Self {
            Self {
                user_text: user_text.into(),
                assistant_text: assistant_text.into(),
                tts_pcm: pcm.to_vec(),
                error: Mutex::new(None),
                cancel_after: false,
                calls: AtomicU32::new(0),
                text_calls: AtomicU32::new(0),
                pcm: Mutex::new(Vec::new()),
                model_id: Mutex::new(None),
            }
        }

        fn fail(error: RealtimeError) -> Self {
            Self {
                user_text: String::new(),
                assistant_text: String::new(),
                tts_pcm: Vec::new(),
                error: Mutex::new(Some(error)),
                cancel_after: false,
                calls: AtomicU32::new(0),
                text_calls: AtomicU32::new(0),
                pcm: Mutex::new(Vec::new()),
                model_id: Mutex::new(None),
            }
        }

        fn cancel_after_turn(user_text: &str, assistant_text: &str) -> Self {
            let mut fake = Self::ok(user_text, assistant_text, &[0x09]);
            fake.cancel_after = true;
            fake
        }
    }

    impl RealtimeModel for FakeRealtime {
        fn transcribe_turn(
            &self,
            _: &ProviderEndpoint,
            _: Option<&str>,
            model_id: &str,
            pcm16le: &[u8],
            _: u32,
            cancel: &AtomicBool,
        ) -> Result<RealtimeTurn, RealtimeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.pcm.lock().expect("pcm") = pcm16le.to_vec();
            *self.model_id.lock().expect("model") = Some(model_id.to_owned());
            if cancel.load(Ordering::SeqCst) {
                return Err(RealtimeError::Cancelled);
            }
            if let Some(error) = self.error.lock().expect("error").take() {
                return Err(error);
            }
            if self.cancel_after {
                cancel.store(true, Ordering::SeqCst);
            }
            Ok(RealtimeTurn {
                user_text: self.user_text.clone(),
                assistant_text: self.assistant_text.clone(),
                tts_pcm: self.tts_pcm.clone(),
            })
        }

        fn text_turn(
            &self,
            request: RealtimeTextRequest<'_>,
            cancel: &AtomicBool,
        ) -> Result<RealtimeTurn, RealtimeError> {
            self.text_calls.fetch_add(1, Ordering::SeqCst);
            *self.model_id.lock().expect("model") = Some(request.model_id.to_owned());
            if cancel.load(Ordering::SeqCst) {
                return Err(RealtimeError::Cancelled);
            }
            if let Some(error) = self.error.lock().expect("error").take() {
                return Err(error);
            }
            Ok(RealtimeTurn {
                user_text: self.user_text.clone(),
                assistant_text: self.assistant_text.clone(),
                tts_pcm: self.tts_pcm.clone(),
            })
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
            e2e: Some("e2e"),
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
            realtime: &UnusedRealtime,
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
            realtime: &UnusedRealtime,
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
            realtime: &UnusedRealtime,
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
            realtime: &UnusedRealtime,
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
    fn finalize_llm_error_returns_to_listening_and_second_finalize_succeeds() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_ready(&mut service, &database);
        let asr = ScriptedAsr::ok("ignored");
        let fail_llm = FailingLlm::new(CascadeError::RequestFailed(
            crate::providers::CascadeStage::Llm,
        ));
        let tts = ScriptedTts::ok(&[0x01]);
        let embed = UnusedEmbed;
        let fail_probes = SessionProbes {
            asr: &asr,
            llm: &fail_llm,
            tts: &tts,
            embed: &embed,
            realtime: &UnusedRealtime,
        };

        let error = service
            .finalize_utterance(
                &database,
                &ready_public_config(),
                &fail_probes,
                credentials(),
                Some("第一轮"),
            )
            .expect_err("llm fail");
        assert_eq!(error.code(), "LLM_REQUEST_FAILED");
        assert_eq!(service.last_error_code(), Some("LLM_REQUEST_FAILED"));
        assert_eq!(service.phase(), SessionPhase::Listening);
        let row = SessionStore::new(&database).get(&id).unwrap().unwrap();
        assert_eq!(row.status, "listening");
        assert!(
            SessionStore::new(&database)
                .list_turns(&id)
                .unwrap()
                .is_empty()
        );

        let ok_llm = ScriptedLlm::ok("第二轮回复");
        let ok_probes = SessionProbes {
            asr: &asr,
            llm: &ok_llm,
            tts: &tts,
            embed: &embed,
            realtime: &UnusedRealtime,
        };
        let turn = service
            .finalize_utterance(
                &database,
                &ready_public_config(),
                &ok_probes,
                credentials(),
                Some("第二轮"),
            )
            .unwrap()
            .expect("second turn");
        assert_eq!(turn.assistant_text, "第二轮回复");
        assert_eq!(service.phase(), SessionPhase::Listening);
        assert_eq!(service.last_error_code(), None);
        assert_eq!(ok_llm.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn finalize_unauthorized_fails_session() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_ready(&mut service, &database);
        let asr = ScriptedAsr::ok("ignored");
        let llm = FailingLlm::new(CascadeError::Unauthorized(
            crate::providers::CascadeStage::Llm,
        ));
        let tts = ScriptedTts::ok(&[0x01]);
        let embed = UnusedEmbed;
        let probes = SessionProbes {
            asr: &asr,
            llm: &llm,
            tts: &tts,
            embed: &embed,
            realtime: &UnusedRealtime,
        };

        let error = service
            .finalize_utterance(
                &database,
                &ready_public_config(),
                &probes,
                credentials(),
                Some("密钥失效"),
            )
            .expect_err("unauthorized");
        assert_eq!(error.code(), "LLM_UNAUTHORIZED");
        assert_eq!(service.last_error_code(), Some("LLM_UNAUTHORIZED"));
        assert_eq!(service.phase(), SessionPhase::Failed);
        let row = SessionStore::new(&database).get(&id).unwrap().unwrap();
        assert_eq!(row.status, "failed");
        assert!(row.finished_at.is_some());
    }

    #[test]
    fn request_cancel_during_slow_llm_skips_tts() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        start_ready(&mut service, &database);
        let entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let proceed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let asr = ScriptedAsr::ok("ignored");
        let llm = GateLlm {
            reply: "不应播报".into(),
            entered: Arc::clone(&entered),
            proceed: Arc::clone(&proceed),
            calls: AtomicU32::new(0),
        };
        let tts = ScriptedTts::ok(&[0x22]);
        let embed = UnusedEmbed;
        let probes = SessionProbes {
            asr: &asr,
            llm: &llm,
            tts: &tts,
            embed: &embed,
            realtime: &UnusedRealtime,
        };
        let control = service.control();
        let waiter = std::thread::spawn(move || {
            while !entered.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            control.request_cancel();
            proceed.store(true, Ordering::SeqCst);
        });

        let error = service
            .finalize_utterance(
                &database,
                &ready_public_config(),
                &probes,
                credentials(),
                Some("取消"),
            )
            .expect_err("cancelled");
        waiter.join().expect("cancel thread");
        assert_eq!(error.code(), "SESSION_CANCELLED");
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
        assert_eq!(tts.calls.load(Ordering::SeqCst), 0);
        assert_eq!(service.phase(), SessionPhase::Listening);
        assert_eq!(service.last_error_code(), Some("SESSION_CANCELLED"));
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
    fn stop_after_sidecar_crash_keeps_failed_status() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_ready(&mut service, &database);

        service.capture().mark_sidecar_exited();
        assert_eq!(service.poll_sidecar(&database).unwrap(), SidecarPoll::Alive);
        service.capture().mark_sidecar_exited();
        let error = service.poll_sidecar(&database).expect_err("second crash");
        assert_eq!(error.code(), "SESSION_SIDECAR_FAILED");
        assert_eq!(service.phase(), SessionPhase::Failed);

        let row = service.stop(&database).unwrap();
        assert_eq!(row.status, "failed");
        assert!(row.finished_at.is_some());
        assert_eq!(service.phase(), SessionPhase::Failed);

        let stored = SessionStore::new(&database).get(&id).unwrap().unwrap();
        assert_eq!(stored.status, "failed");
        assert!(stored.finished_at.is_some());
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

    fn start_e2e(service: &mut SessionService, database: &Database) -> String {
        match service
            .start(database, &ready_e2e_public_config(), true)
            .unwrap()
        {
            SessionStartOutcome::Started { session } => session.id,
            SessionStartOutcome::Blocked { issues } => {
                panic!("expected e2e start, blocked {issues:?}")
            }
        }
    }

    fn e2e_probes<'a>(
        asr: &'a ScriptedAsr,
        llm: &'a ScriptedLlm,
        tts: &'a ScriptedTts,
        embed: &'a UnusedEmbed,
        realtime: &'a FakeRealtime,
    ) -> SessionProbes<'a> {
        SessionProbes {
            asr,
            llm,
            tts,
            embed,
            realtime,
        }
    }

    #[test]
    fn e2e_start_keeps_direct_transport_and_preflight_passes() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_e2e(&mut service, &database);
        assert_eq!(service.phase(), SessionPhase::Listening);
        let row = SessionStore::new(&database).get(&id).unwrap().unwrap();
        assert_eq!(row.transport_mode, "direct");
        assert_eq!(row.status, "listening");
        let snapshots = SessionStore::new(&database).list_snapshots(&id).unwrap();
        assert_eq!(snapshots[0].transport_mode, "direct");
        assert!(snapshots[0].provider_ids.contains("e2e-1"));
        assert!(snapshots[0].model_ids.contains("gpt-realtime"));
    }

    #[test]
    fn e2e_fake_realtime_turn_persists_and_sets_unused_materials() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_e2e(&mut service, &database);
        service.push_pcm(&[0x10, 0x00, 0x20, 0x00]);
        let asr = ScriptedAsr::ok("should-not-run");
        let llm = ScriptedLlm::ok("should-not-run");
        let tts = ScriptedTts::ok(&[0x99]);
        let embed = UnusedEmbed;
        let realtime = FakeRealtime::ok("你好", "实时回复", &[0x01, 0x02]);
        let probes = e2e_probes(&asr, &llm, &tts, &embed, &realtime);

        let turn = service
            .finalize_utterance(
                &database,
                &ready_e2e_public_config(),
                &probes,
                credentials(),
                None,
            )
            .unwrap()
            .expect("turn");

        assert_eq!(turn.user_text, "你好");
        assert_eq!(turn.assistant_text, "实时回复");
        assert_eq!(turn.tts_pcm, [0x01, 0x02]);
        assert!(!turn.materials_used);
        assert_eq!(realtime.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            realtime.model_id.lock().expect("model").as_deref(),
            Some("gpt-realtime")
        );
        assert_eq!(
            realtime.pcm.lock().expect("pcm").as_slice(),
            service.capture().pcm_for_asr().as_slice()
        );
        assert_eq!(asr.calls.load(Ordering::SeqCst), 0);
        assert_eq!(llm.calls.load(Ordering::SeqCst), 0);
        assert_eq!(tts.calls.load(Ordering::SeqCst), 0);
        assert_eq!(service.phase(), SessionPhase::Listening);
        assert!(service.unused_materials());

        let stored = SessionStore::new(&database).list_turns(&id).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].user_text, "你好");
        assert_eq!(stored[0].assistant_text, "实时回复");
        assert!(!stored[0].materials_used);
    }

    #[test]
    fn e2e_cancel_between_realtime_and_persist_returns_to_listening() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_e2e(&mut service, &database);
        let asr = ScriptedAsr::ok("ignored");
        let llm = ScriptedLlm::ok("ignored");
        let tts = ScriptedTts::ok(&[0x01]);
        let embed = UnusedEmbed;
        let realtime = FakeRealtime::cancel_after_turn("取消前", "不应落库");
        let probes = e2e_probes(&asr, &llm, &tts, &embed, &realtime);

        let error = service
            .finalize_utterance(
                &database,
                &ready_e2e_public_config(),
                &probes,
                credentials(),
                None,
            )
            .expect_err("cancelled");
        assert_eq!(error.code(), "SESSION_CANCELLED");
        assert_eq!(service.last_error_code(), Some("SESSION_CANCELLED"));
        assert_eq!(service.phase(), SessionPhase::Listening);
        assert!(
            SessionStore::new(&database)
                .list_turns(&id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(realtime.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn e2e_unauthorized_fails_session() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_e2e(&mut service, &database);
        let asr = ScriptedAsr::ok("ignored");
        let llm = ScriptedLlm::ok("ignored");
        let tts = ScriptedTts::ok(&[0x01]);
        let embed = UnusedEmbed;
        let realtime = FakeRealtime::fail(RealtimeError::Unauthorized);
        let probes = e2e_probes(&asr, &llm, &tts, &embed, &realtime);

        let error = service
            .finalize_utterance(
                &database,
                &ready_e2e_public_config(),
                &probes,
                credentials(),
                None,
            )
            .expect_err("unauthorized");
        assert_eq!(error.code(), "REALTIME_UNAUTHORIZED");
        assert_eq!(service.last_error_code(), Some("REALTIME_UNAUTHORIZED"));
        assert_eq!(service.phase(), SessionPhase::Failed);
        let row = SessionStore::new(&database).get(&id).unwrap().unwrap();
        assert_eq!(row.status, "failed");
        assert!(row.finished_at.is_some());
    }

    #[test]
    fn e2e_retrieves_materials_after_final_user_text() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("app.sqlite3")).unwrap();
        database.migrate().unwrap();
        let path = directory.path().join("note.txt");
        std::fs::write(&path, "负责订单服务与 Kafka 链路，完整句子用于检索。").unwrap();
        crate::services::MaterialService::new(&database, directory.path())
            .import_file(&path)
            .unwrap();

        let mut service = SessionService::new();
        match service
            .start(&database, &ready_e2e_public_config(), true)
            .unwrap()
        {
            SessionStartOutcome::Started { .. } => {}
            SessionStartOutcome::Blocked { issues } => panic!("blocked {issues:?}"),
        }
        let asr = ScriptedAsr::ok("ignored");
        let llm = ScriptedLlm::ok("ignored");
        let tts = ScriptedTts::ok(&[0x01]);
        let embed = UnusedEmbed;
        let realtime = FakeRealtime::ok("订单服务", "资料回答", &[0x02]);
        let probes = e2e_probes(&asr, &llm, &tts, &embed, &realtime);

        let turn = service
            .finalize_utterance(
                &database,
                &ready_e2e_public_config(),
                &probes,
                credentials(),
                None,
            )
            .unwrap()
            .expect("turn");
        assert!(turn.materials_used);
        assert!(!service.unused_materials());
        assert!(
            turn.citations
                .iter()
                .any(|citation| citation.snippet.contains("订单服务"))
        );
    }

    fn cascaded_probes<'a>(
        asr: &'a ScriptedAsr,
        llm: &'a ScriptedLlm,
        tts: &'a ScriptedTts,
        embed: &'a UnusedEmbed,
    ) -> SessionProbes<'a> {
        SessionProbes {
            asr,
            llm,
            tts,
            embed,
            realtime: &UnusedRealtime,
        }
    }

    fn parse_cmd(payload: serde_json::Value) -> crate::runtime::AgentCommand {
        crate::runtime::parse_agent_command(&payload).expect("command")
    }

    #[test]
    fn say_speaks_via_tts_and_result_omits_pcm() {
        let (_directory, database) = opened();
        let mut service = SessionService::with_sink(RecordingSink::default());
        start_ready_sink(&mut service, &database, &ready_public_config());
        let asr = ScriptedAsr::ok("ignored");
        let llm = ScriptedLlm::ok("should-not-run");
        let tts = ScriptedTts::ok(&[0x11, 0x22]);
        let embed = UnusedEmbed;
        let probes = cascaded_probes(&asr, &llm, &tts, &embed);

        let outcome = service
            .execute_command(
                &database,
                &ready_public_config(),
                &probes,
                credentials(),
                parse_cmd(serde_json::json!({
                    "v": 1,
                    "id": "cmd-say",
                    "action": "say",
                    "text": "请开始"
                })),
            )
            .expect("say");

        assert!(outcome.ok);
        assert_eq!(outcome.command_id, "cmd-say");
        assert_eq!(outcome.action.as_str(), "say");
        assert_eq!(outcome.result["text"], "请开始");
        assert_eq!(outcome.error, "");
        assert_eq!(tts.calls.load(Ordering::SeqCst), 1);
        assert_eq!(llm.calls.load(Ordering::SeqCst), 0);
        assert_eq!(service.sink().recorded(), [0x11, 0x22]);
        let json = serde_json::to_string(&outcome.result).unwrap();
        assert!(!json.contains("pcm"));
        assert!(!json.to_ascii_lowercase().contains("sk-"));
    }

    #[test]
    fn retry_replaces_last_assistant_and_revision_mismatch_fails_closed() {
        let (_directory, database) = opened();
        let mut service = SessionService::new();
        let id = start_ready(&mut service, &database);
        let asr = ScriptedAsr::ok("ignored");
        let first = ScriptedLlm::ok("原回复");
        let tts = ScriptedTts::ok(&[0x01]);
        let embed = UnusedEmbed;
        service
            .finalize_utterance(
                &database,
                &ready_public_config(),
                &cascaded_probes(&asr, &first, &tts, &embed),
                credentials(),
                Some("你好"),
            )
            .unwrap()
            .expect("turn");
        assert_eq!(service.revision(), 1);

        let stale = service
            .execute_command(
                &database,
                &ready_public_config(),
                &cascaded_probes(&asr, &first, &tts, &embed),
                credentials(),
                parse_cmd(serde_json::json!({
                    "v": 1,
                    "id": "cmd-stale",
                    "action": "retry",
                    "expectedRevision": 0
                })),
            )
            .expect("stale outcome");
        assert!(!stale.ok);
        assert_eq!(stale.error, "SESSION_CHANGED");
        assert_eq!(
            SessionStore::new(&database).list_turns(&id).unwrap()[0].assistant_text,
            "原回复"
        );

        let retry_llm = ScriptedLlm::ok("新回复");
        let outcome = service
            .execute_command(
                &database,
                &ready_public_config(),
                &cascaded_probes(&asr, &retry_llm, &tts, &embed),
                credentials(),
                parse_cmd(serde_json::json!({
                    "v": 1,
                    "id": "cmd-retry",
                    "action": "retry",
                    "expectedRevision": 1
                })),
            )
            .expect("retry");
        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(outcome.result["question"], "新回复");
        assert_eq!(service.revision(), 2);
        assert_eq!(
            SessionStore::new(&database).list_turns(&id).unwrap()[0].assistant_text,
            "新回复"
        );
    }

    #[test]
    fn correct_replaces_last_assistant_and_speaks_given_text() {
        let (_directory, database) = opened();
        let mut service = SessionService::with_sink(RecordingSink::default());
        let id = start_ready_sink(&mut service, &database, &ready_public_config());
        let asr = ScriptedAsr::ok("ignored");
        let llm = ScriptedLlm::ok("原回复");
        let tts = ScriptedTts::ok(&[0x33]);
        let embed = UnusedEmbed;
        service
            .finalize_utterance(
                &database,
                &ready_public_config(),
                &cascaded_probes(&asr, &llm, &tts, &embed),
                credentials(),
                Some("你好"),
            )
            .unwrap();

        let outcome = service
            .execute_command(
                &database,
                &ready_public_config(),
                &cascaded_probes(&asr, &llm, &tts, &embed),
                credentials(),
                parse_cmd(serde_json::json!({
                    "v": 1,
                    "id": "cmd-correct",
                    "action": "correct",
                    "answer": "改成这句",
                    "expectedRevision": 1
                })),
            )
            .expect("correct");
        assert!(outcome.ok);
        assert_eq!(outcome.result["answer"], "改成这句");
        assert_eq!(
            SessionStore::new(&database).list_turns(&id).unwrap()[0].assistant_text,
            "改成这句"
        );
        assert!(service.sink().recorded().ends_with(&[0x33]));
        assert_eq!(service.revision(), 2);
    }

    #[test]
    fn report_returns_summary_without_speaking_or_secrets() {
        let (_directory, database) = opened();
        let mut service = SessionService::with_sink(RecordingSink::default());
        start_ready_sink(&mut service, &database, &ready_public_config());
        let asr = ScriptedAsr::ok("ignored");
        let llm = ScriptedLlm::ok(
            r#"{"summary":"短纪要","strengths":[],"followUps":[],"limitations":[],"evidence":[]}"#,
        );
        let tts = ScriptedTts::ok(&[0x44]);
        let embed = UnusedEmbed;
        let before = service.sink().recorded().len();
        let outcome = service
            .execute_command(
                &database,
                &ready_public_config(),
                &cascaded_probes(&asr, &llm, &tts, &embed),
                credentials(),
                parse_cmd(serde_json::json!({
                    "v": 1,
                    "id": "cmd-report",
                    "action": "report"
                })),
            )
            .expect("report");
        assert!(outcome.ok);
        assert_eq!(outcome.result["summary"], "短纪要");
        assert_eq!(tts.calls.load(Ordering::SeqCst), 0);
        assert_eq!(service.sink().recorded().len(), before);
        let json = serde_json::to_string(&outcome.result).unwrap();
        assert!(!json.contains("pcm"));
        assert!(!json.to_ascii_lowercase().contains("sk-"));
    }

    #[test]
    fn e2e_say_uses_realtime_text_turn() {
        let (_directory, database) = opened();
        let mut service = SessionService::with_sink(RecordingSink::default());
        start_ready_sink(&mut service, &database, &ready_e2e_public_config());
        let asr = ScriptedAsr::ok("should-not-run");
        let llm = ScriptedLlm::ok("should-not-run");
        let tts = ScriptedTts::ok(&[0x99]);
        let embed = UnusedEmbed;
        let realtime = FakeRealtime::ok("", "请开始", &[0x55, 0x66]);
        let probes = e2e_probes(&asr, &llm, &tts, &embed, &realtime);
        let outcome = service
            .execute_command(
                &database,
                &ready_e2e_public_config(),
                &probes,
                credentials(),
                parse_cmd(serde_json::json!({
                    "v": 1,
                    "id": "cmd-e2e-say",
                    "action": "say",
                    "text": "请开始"
                })),
            )
            .expect("e2e say");
        assert!(outcome.ok);
        assert_eq!(realtime.text_calls.load(Ordering::SeqCst), 1);
        assert_eq!(asr.calls.load(Ordering::SeqCst), 0);
        assert_eq!(llm.calls.load(Ordering::SeqCst), 0);
        assert_eq!(tts.calls.load(Ordering::SeqCst), 0);
        assert_eq!(service.sink().recorded(), [0x55, 0x66]);
    }
}
