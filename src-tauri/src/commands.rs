use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, State};

use crate::{
    app_state::AppState,
    config::{
        EmbeddingConfig, LiveKitConfig, ProviderConfig, PublicConfig, RoleProfileConfig,
        VoiceRouteConfig, diagnostic_view, public_view,
    },
    contracts::{
        AudioLevelEvent, CommandResult, DiagnosticsExportResult, FoundationStatus, RuntimeStatus,
        SessionCitationView, SessionDetail, SessionExportResult, SessionReplyEvent,
        SessionStartResult, SessionSummary, SessionTranscriptEvent, SessionTurnView, StartupState,
    },
    error::PublicError,
    providers::{
        OfficialLiveKitProbe, OpenAiCompatibleCascade, OpenAiCompatibleEmbeddingProbe,
        OpenAiCompatibleProbe,
    },
    runtime::{AgentMode, CascadeCredentials, active_embedding, active_voice_route, preflight},
    services::{
        EmbeddingConfigSaveInput, EmbeddingService, EmbeddingServiceError, EmbeddingTestResult,
        LiveKitSettingsError, LiveKitSettingsSaveInput, LiveKitSettingsService, LiveKitTestResult,
        MaterialSearchHit, MaterialService, MaterialServiceError, MaterialSummary,
        ModelDiscoveryResult, ProviderSaveInput, ProviderService, ProviderServiceError,
        ProviderTestResult, RoleProfileCopyInput, RoleProfileSaveInput, RoleProfileService,
        RoleProfileServiceError, SessionProbes, SessionServiceError, SessionStartOutcome,
        VoiceRouteSaveInput, VoiceRouteService, VoiceRouteServiceError, VoiceRouteTestResult,
    },
    sessions::{SessionExportError, SessionExportFormat, SessionStore, export_session},
};

#[tauri::command]
pub fn foundation_get_status() -> CommandResult<FoundationStatus> {
    CommandResult::Ok {
        data: FoundationStatus { ready: true },
    }
}

#[tauri::command]
pub fn diagnostics_export(
    state: State<'_, AppState>,
    destination: String,
) -> CommandResult<DiagnosticsExportResult> {
    let public_config = match state.config.load() {
        Ok(config) => match serde_json::to_value(diagnostic_view(&config)) {
            Ok(value) => value,
            Err(_) => {
                return CommandResult::Err {
                    error: PublicError::new(
                        "DIAGNOSTICS_OPERATION_FAILED",
                        "Diagnostic operation failed",
                        false,
                    ),
                };
            }
        },
        Err(error) => {
            return CommandResult::Err {
                error: PublicError::new(
                    error.code(),
                    "Configuration is unavailable for export",
                    false,
                ),
            };
        }
    };
    let database_status = state
        .database
        .lock()
        .ok()
        .and_then(|database| {
            database
                .as_ref()
                .and_then(|database| database.integrity_check().ok())
        })
        .unwrap_or_else(|| "unavailable".to_owned());
    let service_status = serde_json::json!({ "database": database_status });
    match state.diagnostics.export(
        std::path::Path::new(&destination),
        public_config,
        service_status,
    ) {
        Ok(()) => CommandResult::Ok {
            data: DiagnosticsExportResult { exported: true },
        },
        Err(error) => CommandResult::Err {
            error: PublicError::new(error.code(), error.to_string(), false),
        },
    }
}

#[tauri::command]
pub fn config_get_startup_state(state: State<'_, AppState>) -> CommandResult<StartupState> {
    CommandResult::Ok {
        data: state.startup_state(),
    }
}

/// Thin, read-only projection of the loaded configuration onto its redacted
/// public contract. The real logic lives in [`crate::config::public_view`]; this
/// only maps the load outcome into a [`CommandResult`]. It never writes and never
/// reads a secret value — credentials surface only as `SecretSlot` references.
fn public_config(state: &AppState) -> CommandResult<PublicConfig> {
    match state.config.load() {
        Ok(config) => CommandResult::Ok {
            data: public_view(&config),
        },
        Err(error) => CommandResult::Err {
            error: PublicError::new(error.code(), "Configuration is unavailable", false),
        },
    }
}

#[tauri::command]
pub fn config_get_public(state: State<'_, AppState>) -> CommandResult<PublicConfig> {
    public_config(&state)
}

fn service_error<T: ts_rs::TS>(code: &str, message: &str) -> CommandResult<T> {
    CommandResult::Err {
        error: PublicError::new(code, message, false),
    }
}

fn provider_service_error<T: ts_rs::TS>(error: ProviderServiceError) -> CommandResult<T> {
    let code = error.code();
    let mut public = PublicError::new(
        code,
        "Provider operation failed",
        matches!(code, "PROVIDER_TIMEOUT" | "PROVIDER_REQUEST_FAILED"),
    );
    if let Some(field) = match code {
        "PROVIDER_ID_INVALID" => Some("id"),
        "CONFIG_URL_INVALID" | "PROVIDER_ENDPOINT_INVALID" => Some("baseUrl"),
        _ => None,
    } {
        public = public.with_field(field);
    }
    CommandResult::Err { error: public }
}

fn role_service_error<T: ts_rs::TS>(error: RoleProfileServiceError) -> CommandResult<T> {
    let code = error.code();
    let message = if code == "ROLE_PROFILE_REVIEW_REQUIRED" {
        "Review and save this role profile before activating or copying it"
    } else {
        "Role profile operation failed"
    };
    let mut public = PublicError::new(code, message, false);
    if let Some(field) = match code {
        "ROLE_PROFILE_ID_INVALID"
        | "ROLE_PROFILE_COPY_ID_IN_USE"
        | "ROLE_PROFILE_REVIEW_REQUIRED"
        | "ROLE_PROFILE_NOT_FOUND" => Some("id"),
        "ROLE_PROFILE_FIELDS_INVALID" => Some("name"),
        _ => None,
    } {
        public = public.with_field(field);
    }
    CommandResult::Err { error: public }
}

fn embedding_service_error<T: ts_rs::TS>(error: EmbeddingServiceError) -> CommandResult<T> {
    let code = error.code();
    let mut public = PublicError::new(
        code,
        "Embedding configuration operation failed",
        matches!(code, "EMBEDDING_TIMEOUT" | "EMBEDDING_REQUEST_FAILED"),
    );
    if let Some(field) = match code {
        "EMBEDDING_ID_INVALID"
        | "EMBEDDING_NOT_FOUND"
        | "EMBEDDING_NOT_READY"
        | "EMBEDDING_STALE" => Some("id"),
        "EMBEDDING_FIELDS_INVALID" => Some("dimensions"),
        "CONFIG_REFERENCE_MISSING" => Some("providerId"),
        "CONFIG_URL_INVALID" | "EMBEDDING_ENDPOINT_INVALID" => Some("baseUrl"),
        _ => None,
    } {
        public = public.with_field(field);
    }
    CommandResult::Err { error: public }
}

fn livekit_service_error<T: ts_rs::TS>(error: LiveKitSettingsError) -> CommandResult<T> {
    let code = error.code();
    let mut public = PublicError::new(
        code,
        "LiveKit settings operation failed",
        matches!(code, "LIVEKIT_TIMEOUT" | "LIVEKIT_REQUEST_FAILED"),
    );
    if let Some(field) = match code {
        "CONFIG_URL_INVALID" | "LIVEKIT_ENDPOINT_INVALID" => Some("url"),
        "LIVEKIT_CREDENTIALS_MISSING" => Some("apiKey"),
        "LIVEKIT_NOT_READY" => Some("enabled"),
        _ => None,
    } {
        public = public.with_field(field);
    }
    CommandResult::Err { error: public }
}

fn route_service_error<T: ts_rs::TS>(error: VoiceRouteServiceError) -> CommandResult<T> {
    let code = error.code();
    let mut public = PublicError::new(
        code,
        "Voice route operation failed",
        matches!(code, "PROVIDER_TIMEOUT" | "PROVIDER_REQUEST_FAILED"),
    );
    if let Some(field) = match code {
        "VOICE_ROUTE_ID_INVALID" => Some("id"),
        "VOICE_ROUTE_FIELDS_INVALID" | "VOICE_ROUTE_MODEL_NOT_FOUND" => Some("route"),
        _ => None,
    } {
        public = public.with_field(field);
    }
    CommandResult::Err { error: public }
}

fn provider_probe<T: ts_rs::TS>() -> Result<OpenAiCompatibleProbe, CommandResult<T>> {
    OpenAiCompatibleProbe::new()
        .map_err(|error| service_error(error.code(), "Provider client is unavailable"))
}

fn embedding_probe<T: ts_rs::TS>() -> Result<OpenAiCompatibleEmbeddingProbe, CommandResult<T>> {
    OpenAiCompatibleEmbeddingProbe::new()
        .map_err(|error| service_error(error.code(), "Embedding client is unavailable"))
}

fn livekit_probe<T: ts_rs::TS>() -> Result<OfficialLiveKitProbe, CommandResult<T>> {
    OfficialLiveKitProbe::new()
        .map_err(|error| service_error(error.code(), "LiveKit client is unavailable"))
}

fn material_service_error<T: ts_rs::TS>(error: MaterialServiceError) -> CommandResult<T> {
    let code = error.code();
    let message = match code {
        "MATERIAL_TYPE_UNSUPPORTED" => "Unsupported material type",
        "MATERIAL_TOO_LARGE" => "Material is too large",
        "MATERIAL_NOT_UTF8" => "Material is not valid UTF-8",
        "MATERIAL_NO_TEXT_LAYER" => "Material has no extractable text",
        "MATERIAL_PARSE_FAILED" => "Material could not be parsed",
        "MATERIAL_NOT_FOUND" => "Material not found",
        "MATERIAL_PATH_INVALID" => "Material path is invalid",
        _ => "Material operation failed",
    };
    let mut public = PublicError::new(code, message, false);
    if let Some(field) = match code {
        "MATERIAL_PATH_INVALID" => Some("path"),
        "MATERIAL_NOT_FOUND" => Some("id"),
        _ => None,
    } {
        public = public.with_field(field);
    }
    CommandResult::Err { error: public }
}

fn resolve_import_path(path: &str) -> Result<std::path::PathBuf, MaterialServiceError> {
    let path = std::path::Path::new(path);
    if path.is_relative() {
        return Err(MaterialServiceError::PathInvalid);
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| MaterialServiceError::PathInvalid)?;
    if !canonical.is_file() {
        return Err(MaterialServiceError::PathInvalid);
    }
    Ok(canonical)
}

fn with_materials<T: serde::Serialize + ts_rs::TS>(
    state: &AppState,
    work: impl FnOnce(&MaterialService<'_>) -> Result<T, MaterialServiceError>,
) -> CommandResult<T> {
    let database = match state.database.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
        }
    };
    let Some(database) = database.as_ref() else {
        return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
    };
    work(&MaterialService::new(database, &state.paths.data_directory))
        .map_or_else(material_service_error, |data| CommandResult::Ok { data })
}

fn material_list_cmd(state: &AppState) -> CommandResult<Vec<MaterialSummary>> {
    with_materials(state, |service| service.list())
}

fn material_import_cmd(state: &AppState, path: String) -> CommandResult<MaterialSummary> {
    let path = match resolve_import_path(&path) {
        Ok(path) => path,
        Err(error) => return material_service_error(error),
    };
    with_materials(state, |service| service.import_file(path))
}

fn material_search_cmd(
    state: &AppState,
    query: String,
    top_k: Option<u32>,
) -> CommandResult<Vec<MaterialSearchHit>> {
    with_materials(state, |service| service.search_text(&query, top_k))
}

fn material_delete_cmd(state: &AppState, id: String) -> CommandResult<FoundationStatus> {
    with_materials(state, |service| {
        service.delete(&id)?;
        Ok(FoundationStatus { ready: true })
    })
}

#[tauri::command]
pub fn material_list(state: State<'_, AppState>) -> CommandResult<Vec<MaterialSummary>> {
    material_list_cmd(&state)
}

#[tauri::command]
pub fn material_import(state: State<'_, AppState>, path: String) -> CommandResult<MaterialSummary> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    material_import_cmd(&state, path)
}

#[tauri::command]
pub fn material_search(
    state: State<'_, AppState>,
    query: String,
    top_k: Option<u32>,
) -> CommandResult<Vec<MaterialSearchHit>> {
    material_search_cmd(&state, query, top_k)
}

#[tauri::command]
pub fn material_delete(state: State<'_, AppState>, id: String) -> CommandResult<FoundationStatus> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    material_delete_cmd(&state, id)
}

const EVENT_RUNTIME_STATUS: &str = "runtime.status.v1";
const EVENT_AUDIO_LEVEL: &str = "audio.level.v1";
const EVENT_SESSION_TRANSCRIPT: &str = "session.transcript.v1";
const EVENT_SESSION_REPLY: &str = "session.reply.v1";

fn session_service_error<T: ts_rs::TS>(error: SessionServiceError) -> CommandResult<T> {
    let code = error.code();
    let message = match code {
        "SESSION_ALREADY_ACTIVE" => "A session is already active",
        "SESSION_NOT_FOUND" => "Session not found",
        "SESSION_STATE_INVALID" => "Session state is invalid",
        _ => "Session operation failed",
    };
    let mut public = PublicError::new(code, message, false);
    if matches!(code, "SESSION_NOT_FOUND") {
        public = public.with_field("sessionId");
    }
    CommandResult::Err { error: public }
}

fn clip_snippet(text: &str) -> String {
    text.chars().take(160).collect()
}

fn load_public_config(state: &AppState) -> Result<PublicConfig, PublicError> {
    match state.config.load() {
        Ok(config) => Ok(public_view(&config)),
        Err(error) => Err(PublicError::new(
            error.code(),
            "Configuration is unavailable",
            false,
        )),
    }
}

fn secrets_backend_ready(state: &AppState) -> bool {
    state.secrets.status("system/startup-probe").is_ok()
}

fn runtime_status_from_state(state: &AppState) -> RuntimeStatus {
    let seq = state.event_seq.load(Ordering::SeqCst);
    match state.sessions.lock() {
        Ok(sessions) => RuntimeStatus {
            phase: sessions.phase().as_str().to_owned(),
            mode: sessions.mode().as_str().to_owned(),
            seq,
            unused_materials: sessions.unused_materials(),
            last_error_code: sessions.last_error_code().map(str::to_owned),
        },
        Err(_) => RuntimeStatus {
            phase: "idle".into(),
            mode: "ai_active".into(),
            seq,
            unused_materials: false,
            last_error_code: Some("SERVICE_BUSY".into()),
        },
    }
}

fn bump_event_seq(state: &AppState) -> u64 {
    state.event_seq.fetch_add(1, Ordering::SeqCst);
    state.event_seq.load(Ordering::SeqCst)
}

fn bump_runtime_status(state: &AppState) -> RuntimeStatus {
    bump_event_seq(state);
    runtime_status_from_state(state)
}

fn emit_runtime(app: &AppHandle, state: &AppState) {
    let status = bump_runtime_status(state);
    let _ = app.emit(EVENT_RUNTIME_STATUS, &status);
    if let Ok(sessions) = state.sessions.lock() {
        let _ = app.emit(
            EVENT_AUDIO_LEVEL,
            AudioLevelEvent {
                peak: sessions.capture().last_peak(),
                seq: status.seq,
            },
        );
    }
}

#[cfg(test)]
fn runtime_status_event(
    seq: u64,
    phase: &str,
    mode: &str,
    unused_materials: bool,
    last_error_code: Option<&str>,
) -> serde_json::Value {
    serde_json::to_value(RuntimeStatus {
        phase: phase.to_owned(),
        mode: mode.to_owned(),
        seq,
        unused_materials,
        last_error_code: last_error_code.map(str::to_owned),
    })
    .expect("runtime status")
}

#[cfg(test)]
fn transcript_event(seq: u64, text: &str) -> serde_json::Value {
    serde_json::to_value(SessionTranscriptEvent {
        seq,
        text: clip_snippet(text),
    })
    .expect("transcript event")
}

#[cfg(test)]
fn reply_event(seq: u64, text: &str) -> serde_json::Value {
    serde_json::to_value(SessionReplyEvent {
        seq,
        text: clip_snippet(text),
    })
    .expect("reply event")
}

#[cfg(test)]
fn audio_level_event(seq: u64, peak: f64) -> serde_json::Value {
    serde_json::to_value(AudioLevelEvent { peak, seq }).expect("audio level")
}

fn emit_transcript_and_reply(
    app: &AppHandle,
    state: &AppState,
    user_text: &str,
    assistant_text: &str,
) {
    let _ = app.emit(
        EVENT_SESSION_TRANSCRIPT,
        SessionTranscriptEvent {
            seq: bump_event_seq(state),
            text: clip_snippet(user_text),
        },
    );
    let _ = app.emit(
        EVENT_SESSION_REPLY,
        SessionReplyEvent {
            seq: bump_event_seq(state),
            text: clip_snippet(assistant_text),
        },
    );
}

fn read_provider_secret(
    state: &AppState,
    config: &PublicConfig,
    provider_id: Option<&str>,
) -> Result<Option<zeroize::Zeroizing<String>>, PublicError> {
    let Some(provider_id) = provider_id.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some(provider) = config
        .models
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
    else {
        return Ok(None);
    };
    let Some(slot) = provider.credential.as_ref().filter(|slot| slot.configured) else {
        return Ok(None);
    };
    state.secrets.read(&slot.reference).map_err(|_| {
        PublicError::new(
            "SECRET_BACKEND_UNAVAILABLE",
            "Secret backend is unavailable",
            false,
        )
    })
}

fn session_detail(
    store: &SessionStore<'_>,
    id: &str,
) -> Result<SessionDetail, SessionServiceError> {
    let session = store.get(id)?.ok_or(SessionServiceError::NotFound)?;
    let mut turns = Vec::new();
    for turn in store.list_turns(id)? {
        let citations = store
            .list_citations(&turn.id)?
            .into_iter()
            .map(|citation| SessionCitationView {
                material_id: citation.material_id,
                chunk_id: citation.chunk_id,
                snippet: clip_snippet(&citation.snippet),
            })
            .collect();
        turns.push(SessionTurnView {
            id: turn.id,
            turn_index: turn.turn_index,
            user_text: turn.user_text,
            assistant_text: turn.assistant_text,
            materials_used: turn.materials_used,
            citations,
        });
    }
    Ok(SessionDetail {
        session: session.into(),
        turns,
    })
}

fn session_start_cmd(state: &AppState) -> CommandResult<SessionStartResult> {
    let config = match load_public_config(state) {
        Ok(config) => config,
        Err(error) => return CommandResult::Err { error },
    };
    let secrets_ready = secrets_backend_ready(state);
    let database = match state.database.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
        }
    };
    let Some(database) = database.as_ref() else {
        return CommandResult::Ok {
            data: SessionStartResult::Blocked {
                issues: preflight(&config, secrets_ready, false),
            },
        };
    };
    let mut sessions = match state.sessions.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error(
                "SERVICE_BUSY",
                "Service configuration is temporarily unavailable",
            );
        }
    };
    match sessions.start(database, &config, secrets_ready) {
        Ok(SessionStartOutcome::Started { session }) => CommandResult::Ok {
            data: SessionStartResult::Started {
                session: session.into(),
            },
        },
        Ok(SessionStartOutcome::Blocked { issues }) => CommandResult::Ok {
            data: SessionStartResult::Blocked { issues },
        },
        Err(error) => session_service_error(error),
    }
}

fn session_stop_cmd(state: &AppState) -> CommandResult<SessionSummary> {
    let database = match state.database.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
        }
    };
    let Some(database) = database.as_ref() else {
        return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
    };
    let mut sessions = match state.sessions.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error(
                "SERVICE_BUSY",
                "Service configuration is temporarily unavailable",
            );
        }
    };
    match sessions.stop(database) {
        Ok(session) => CommandResult::Ok {
            data: session.into(),
        },
        Err(error) => session_service_error(error),
    }
}

fn session_set_mode_cmd(state: &AppState, mode: String) -> CommandResult<RuntimeStatus> {
    let Some(mode) = AgentMode::from_name(&mode) else {
        return CommandResult::Err {
            error: PublicError::new("SESSION_MODE_INVALID", "Unsupported session mode", false)
                .with_field("mode"),
        };
    };
    {
        let database = match state.database.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
            }
        };
        let Some(database) = database.as_ref() else {
            return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
        };
        let mut sessions = match state.sessions.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return service_error(
                    "SERVICE_BUSY",
                    "Service configuration is temporarily unavailable",
                );
            }
        };
        if let Err(error) = sessions.set_mode(database, mode) {
            return session_service_error(error);
        }
    }
    CommandResult::Ok {
        data: bump_runtime_status(state),
    }
}

fn session_list_cmd(state: &AppState) -> CommandResult<Vec<SessionSummary>> {
    let database = match state.database.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
        }
    };
    let Some(database) = database.as_ref() else {
        return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
    };
    match SessionStore::new(database).list() {
        Ok(rows) => CommandResult::Ok {
            data: rows.into_iter().map(SessionSummary::from).collect(),
        },
        Err(error) => service_error(error.code(), "Session list failed"),
    }
}

fn session_get_cmd(state: &AppState, session_id: String) -> CommandResult<SessionDetail> {
    let database = match state.database.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
        }
    };
    let Some(database) = database.as_ref() else {
        return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
    };
    match session_detail(&SessionStore::new(database), &session_id) {
        Ok(detail) => CommandResult::Ok { data: detail },
        Err(error) => session_service_error(error),
    }
}

fn session_delete_cmd(state: &AppState, session_id: String) -> CommandResult<FoundationStatus> {
    let database = match state.database.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
        }
    };
    let Some(database) = database.as_ref() else {
        return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
    };
    let mut sessions = match state.sessions.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error(
                "SERVICE_BUSY",
                "Service configuration is temporarily unavailable",
            );
        }
    };
    if sessions.session_id() == Some(session_id.as_str()) {
        sessions.reset();
    }
    match SessionStore::new(database).delete_session(&session_id) {
        Ok(()) => CommandResult::Ok {
            data: FoundationStatus { ready: true },
        },
        Err(error) => service_error(error.code(), "Session delete failed"),
    }
}

fn session_export_cmd(
    state: &AppState,
    session_id: String,
    format: String,
) -> CommandResult<SessionExportResult> {
    let Some(format) = SessionExportFormat::from_name(&format) else {
        return CommandResult::Err {
            error: PublicError::new(
                SessionExportError::FormatInvalid.code(),
                "Unsupported export format",
                false,
            )
            .with_field("format"),
        };
    };
    let database = match state.database.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
        }
    };
    let Some(database) = database.as_ref() else {
        return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
    };
    let export_root = state.paths.data_directory.join("exports");
    match export_session(
        &SessionStore::new(database),
        &session_id,
        format,
        &export_root,
    ) {
        Ok(path) => CommandResult::Ok {
            data: SessionExportResult {
                path: path.to_string_lossy().into_owned(),
            },
        },
        Err(error) => {
            let mut public = PublicError::new(error.code(), "Session export failed", false);
            if error == SessionExportError::NotFound {
                public = public.with_field("sessionId");
            }
            CommandResult::Err { error: public }
        }
    }
}

fn session_finalize_utterance_cmd(
    state: &AppState,
    probes: &SessionProbes<'_>,
    credentials: CascadeCredentials<'_>,
    text: Option<&str>,
) -> CommandResult<SessionTurnView> {
    let config = match load_public_config(state) {
        Ok(config) => config,
        Err(error) => return CommandResult::Err { error },
    };
    let database = match state.database.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
        }
    };
    let Some(database) = database.as_ref() else {
        return service_error("DATABASE_OPERATION_FAILED", "Database is unavailable");
    };
    let mut sessions = match state.sessions.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return service_error(
                "SERVICE_BUSY",
                "Service configuration is temporarily unavailable",
            );
        }
    };
    match sessions.finalize_utterance(database, &config, probes, credentials, text) {
        Ok(Some(_)) => {
            let Some(session_id) = sessions.session_id() else {
                return session_service_error(SessionServiceError::NotFound);
            };
            match session_detail(&SessionStore::new(database), session_id) {
                Ok(detail) => match detail.turns.into_iter().last() {
                    Some(turn) => CommandResult::Ok { data: turn },
                    None => session_service_error(SessionServiceError::StateInvalid),
                },
                Err(error) => session_service_error(error),
            }
        }
        Ok(None) => session_service_error(SessionServiceError::StateInvalid),
        Err(error) => session_service_error(error),
    }
}

fn runtime_get_status_cmd(state: &AppState) -> CommandResult<RuntimeStatus> {
    CommandResult::Ok {
        data: runtime_status_from_state(state),
    }
}

#[tauri::command]
pub fn session_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SessionStartResult> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let result = session_start_cmd(&state);
    if matches!(
        result,
        CommandResult::Ok {
            data: SessionStartResult::Started { .. }
        }
    ) {
        emit_runtime(&app, &state);
    }
    result
}

#[tauri::command]
pub fn session_stop(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSummary> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let result = session_stop_cmd(&state);
    if matches!(result, CommandResult::Ok { .. }) {
        emit_runtime(&app, &state);
    }
    result
}

#[tauri::command]
pub fn session_set_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> CommandResult<RuntimeStatus> {
    let result = session_set_mode_cmd(&state, mode);
    if matches!(result, CommandResult::Ok { .. }) {
        let status = match &result {
            CommandResult::Ok { data } => data.clone(),
            CommandResult::Err { .. } => runtime_status_from_state(&state),
        };
        let _ = app.emit(EVENT_RUNTIME_STATUS, &status);
    }
    result
}

#[tauri::command]
pub fn session_export(
    state: State<'_, AppState>,
    session_id: String,
    format: String,
) -> CommandResult<SessionExportResult> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    session_export_cmd(&state, session_id, format)
}

#[tauri::command]
pub fn session_list(state: State<'_, AppState>) -> CommandResult<Vec<SessionSummary>> {
    session_list_cmd(&state)
}

#[tauri::command]
pub fn session_get(state: State<'_, AppState>, session_id: String) -> CommandResult<SessionDetail> {
    session_get_cmd(&state, session_id)
}

#[tauri::command]
pub fn session_delete(
    state: State<'_, AppState>,
    session_id: String,
) -> CommandResult<FoundationStatus> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    session_delete_cmd(&state, session_id)
}

#[tauri::command]
pub fn session_finalize_utterance(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> CommandResult<SessionTurnView> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let cascade = match OpenAiCompatibleCascade::new() {
        Ok(client) => client,
        Err(error) => return service_error(error.code(), "Cascade client is unavailable"),
    };
    let embed = match OpenAiCompatibleEmbeddingProbe::new() {
        Ok(client) => client,
        Err(error) => return service_error(error.code(), "Embedding client is unavailable"),
    };
    let config = match load_public_config(&state) {
        Ok(config) => config,
        Err(error) => return CommandResult::Err { error },
    };
    let route = active_voice_route(&config);
    let embedding = active_embedding(&config);
    let asr_secret = match read_provider_secret(
        &state,
        &config,
        route.and_then(|item| item.asr_provider_id.as_deref()),
    ) {
        Ok(secret) => secret,
        Err(error) => return CommandResult::Err { error },
    };
    let llm_secret = match read_provider_secret(
        &state,
        &config,
        route.and_then(|item| item.llm_provider_id.as_deref()),
    ) {
        Ok(secret) => secret,
        Err(error) => return CommandResult::Err { error },
    };
    let tts_secret = match read_provider_secret(
        &state,
        &config,
        route.and_then(|item| item.tts_provider_id.as_deref()),
    ) {
        Ok(secret) => secret,
        Err(error) => return CommandResult::Err { error },
    };
    let embed_secret = match read_provider_secret(
        &state,
        &config,
        embedding.map(|item| item.provider_id.as_str()),
    ) {
        Ok(secret) => secret,
        Err(error) => return CommandResult::Err { error },
    };
    let probes = SessionProbes {
        asr: &cascade,
        llm: &cascade,
        tts: &cascade,
        embed: &embed,
    };
    let credentials = CascadeCredentials {
        asr: asr_secret.as_deref().map(String::as_str),
        llm: llm_secret.as_deref().map(String::as_str),
        tts: tts_secret.as_deref().map(String::as_str),
        embed: embed_secret.as_deref().map(String::as_str),
    };
    let trimmed = text.trim();
    let result = session_finalize_utterance_cmd(
        &state,
        &probes,
        credentials,
        (!trimmed.is_empty()).then_some(trimmed),
    );
    if let CommandResult::Ok { data } = &result {
        emit_transcript_and_reply(&app, &state, &data.user_text, &data.assistant_text);
        emit_runtime(&app, &state);
    }
    result
}

#[tauri::command]
pub fn runtime_get_status(state: State<'_, AppState>) -> CommandResult<RuntimeStatus> {
    runtime_get_status_cmd(&state)
}

fn service_guard<T: ts_rs::TS>(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, ()>, CommandResult<T>> {
    state.service_lock.lock().map_err(|_| {
        service_error(
            "SERVICE_BUSY",
            "Service configuration is temporarily unavailable",
        )
    })
}

#[tauri::command(async)]
pub fn model_provider_save(
    state: State<'_, AppState>,
    input: ProviderSaveInput,
) -> CommandResult<ProviderConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match provider_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    ProviderService::new(&state.config, &state.secrets, &probe)
        .save(input)
        .map_or_else(provider_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn model_provider_test(
    state: State<'_, AppState>,
    provider_id: String,
) -> CommandResult<ProviderTestResult> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match provider_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    ProviderService::new(&state.config, &state.secrets, &probe)
        .test(&provider_id)
        .map_or_else(provider_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn model_provider_discover(
    state: State<'_, AppState>,
    provider_id: String,
) -> CommandResult<ModelDiscoveryResult> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match provider_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    ProviderService::new(&state.config, &state.secrets, &probe)
        .discover(&provider_id)
        .map_or_else(provider_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn model_provider_activate(
    state: State<'_, AppState>,
    provider_id: String,
) -> CommandResult<ProviderConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match provider_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    ProviderService::new(&state.config, &state.secrets, &probe)
        .activate(&provider_id)
        .map_or_else(provider_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn model_provider_delete(
    state: State<'_, AppState>,
    provider_id: String,
) -> CommandResult<FoundationStatus> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match provider_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    ProviderService::new(&state.config, &state.secrets, &probe)
        .delete(&provider_id)
        .map_or_else(provider_service_error, |_| CommandResult::Ok {
            data: FoundationStatus { ready: true },
        })
}

#[tauri::command(async)]
pub fn speech_route_save(
    state: State<'_, AppState>,
    input: VoiceRouteSaveInput,
) -> CommandResult<VoiceRouteConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match provider_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    VoiceRouteService::new(&state.config, &state.secrets, &probe)
        .save(input)
        .map_or_else(route_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn speech_route_test(
    state: State<'_, AppState>,
    route_id: String,
) -> CommandResult<VoiceRouteTestResult> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match provider_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    VoiceRouteService::new(&state.config, &state.secrets, &probe)
        .test(&route_id)
        .map_or_else(route_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn speech_route_activate(
    state: State<'_, AppState>,
    route_id: String,
) -> CommandResult<VoiceRouteConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match provider_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    VoiceRouteService::new(&state.config, &state.secrets, &probe)
        .activate(&route_id)
        .map_or_else(route_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn speech_route_delete(
    state: State<'_, AppState>,
    route_id: String,
) -> CommandResult<FoundationStatus> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match provider_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    VoiceRouteService::new(&state.config, &state.secrets, &probe)
        .delete(&route_id)
        .map_or_else(route_service_error, |_| CommandResult::Ok {
            data: FoundationStatus { ready: true },
        })
}

#[tauri::command(async)]
pub fn role_profile_save(
    state: State<'_, AppState>,
    input: RoleProfileSaveInput,
) -> CommandResult<RoleProfileConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    RoleProfileService::new(&state.config)
        .save(input)
        .map_or_else(role_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn role_profile_copy(
    state: State<'_, AppState>,
    input: RoleProfileCopyInput,
) -> CommandResult<RoleProfileConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    RoleProfileService::new(&state.config)
        .copy(input)
        .map_or_else(role_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn role_profile_activate(
    state: State<'_, AppState>,
    role_id: String,
) -> CommandResult<RoleProfileConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    RoleProfileService::new(&state.config)
        .activate(&role_id)
        .map_or_else(role_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn role_profile_delete(
    state: State<'_, AppState>,
    role_id: String,
) -> CommandResult<FoundationStatus> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    RoleProfileService::new(&state.config)
        .delete(&role_id)
        .map_or_else(role_service_error, |_| CommandResult::Ok {
            data: FoundationStatus { ready: true },
        })
}

#[tauri::command(async)]
pub fn embedding_config_save(
    state: State<'_, AppState>,
    input: EmbeddingConfigSaveInput,
) -> CommandResult<EmbeddingConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match embedding_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    EmbeddingService::new(&state.config, &state.secrets, &probe)
        .save(input)
        .map_or_else(embedding_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn embedding_config_test(
    state: State<'_, AppState>,
    embedding_id: String,
) -> CommandResult<EmbeddingTestResult> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match embedding_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    EmbeddingService::new(&state.config, &state.secrets, &probe)
        .test(&embedding_id)
        .map_or_else(embedding_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn embedding_config_activate(
    state: State<'_, AppState>,
    embedding_id: String,
) -> CommandResult<EmbeddingConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match embedding_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    EmbeddingService::new(&state.config, &state.secrets, &probe)
        .activate(&embedding_id)
        .map_or_else(embedding_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn embedding_config_delete(
    state: State<'_, AppState>,
    embedding_id: String,
) -> CommandResult<FoundationStatus> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match embedding_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    EmbeddingService::new(&state.config, &state.secrets, &probe)
        .delete(&embedding_id)
        .map_or_else(embedding_service_error, |_| CommandResult::Ok {
            data: FoundationStatus { ready: true },
        })
}

#[tauri::command(async)]
pub fn livekit_settings_save(
    state: State<'_, AppState>,
    input: LiveKitSettingsSaveInput,
) -> CommandResult<LiveKitConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match livekit_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    LiveKitSettingsService::new(&state.config, &state.secrets, &probe)
        .save(input)
        .map_or_else(livekit_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn livekit_settings_test(state: State<'_, AppState>) -> CommandResult<LiveKitTestResult> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match livekit_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    LiveKitSettingsService::new(&state.config, &state.secrets, &probe)
        .test()
        .map_or_else(livekit_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command(async)]
pub fn livekit_settings_enable(
    state: State<'_, AppState>,
    enabled: bool,
) -> CommandResult<LiveKitConfig> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let probe = match livekit_probe() {
        Ok(probe) => probe,
        Err(error) => return error,
    };
    LiveKitSettingsService::new(&state.config, &state.secrets, &probe)
        .set_enabled(enabled)
        .map_or_else(livekit_service_error, |data| CommandResult::Ok { data })
}

#[tauri::command]
pub fn config_restore_last_good(state: State<'_, AppState>) -> CommandResult<StartupState> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    CommandResult::Ok {
        data: state.restore_last_good(),
    }
}

#[tauri::command]
pub fn config_restore_defaults(state: State<'_, AppState>) -> CommandResult<StartupState> {
    let _guard = match service_guard(&state) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    CommandResult::Ok {
        data: state.restore_defaults(),
    }
}

#[tauri::command]
pub fn open_app_directory(
    state: State<'_, AppState>,
    kind: String,
) -> CommandResult<FoundationStatus> {
    let directory = match kind.as_str() {
        "config" => state
            .paths
            .config_path
            .parent()
            .map(std::path::Path::to_path_buf),
        "data" => Some(state.paths.data_directory.clone()),
        _ => None,
    };
    let Some(directory) = directory else {
        return CommandResult::Err {
            error: PublicError::new(
                "APP_DIRECTORY_INVALID",
                "Unsupported application directory",
                false,
            ),
        };
    };
    match open_directory(&directory) {
        Ok(()) => CommandResult::Ok {
            data: FoundationStatus { ready: true },
        },
        Err(()) => CommandResult::Err {
            error: PublicError::new(
                "APP_DIRECTORY_OPEN_FAILED",
                "Application directory could not be opened",
                false,
            ),
        },
    }
}

#[cfg(windows)]
fn open_directory(path: &std::path::Path) -> Result<(), ()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let operation = "open".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let path = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            path.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err(())
    }
}

#[cfg(not(windows))]
fn open_directory(_: &std::path::Path) -> Result<(), ()> {
    Err(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        embedding_service_error, livekit_service_error, provider_service_error, public_config,
        role_service_error, route_service_error,
    };
    use crate::{
        app_state::{AppPaths, AppState},
        providers::ProviderError,
        secrets::MemorySecretStore,
        services::{
            EmbeddingServiceError, LiveKitSettingsError, ProviderServiceError,
            RoleProfileServiceError, VoiceRouteServiceError,
        },
    };

    #[test]
    fn config_get_public_returns_redacted_config_without_secret_material() {
        let directory = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            data_directory: directory.path().join("data"),
            logs_directory: directory.path().join("logs"),
            config_path: directory.path().join("config.json"),
        };
        std::fs::write(
            &paths.config_path,
            r#"{"configVersion":1,"models":{"providers":[{"id":"p1","baseUrl":"https://one.example","credential":{"reference":"providers/p1/api-key","configured":true}}]}}"#,
        )
        .unwrap();
        let state = AppState::initialize(paths, Arc::new(MemorySecretStore::default())).unwrap();

        let json = serde_json::to_string(&public_config(&state)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["data"]["configVersion"], 1);
        let credential = &value["data"]["models"]["providers"][0]["credential"];
        assert_eq!(credential["reference"], "providers/p1/api-key");
        assert_eq!(credential["configured"], true);
        assert_eq!(
            credential.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["configured", "reference"]
        );
        let livekit = &value["data"]["transport"]["livekit"];
        assert!(livekit.get("apiKey").is_some());
        assert!(livekit.get("apiSecret").is_some());
        assert!(
            livekit.get("apiKey").unwrap().is_null()
                || livekit["apiKey"].get("reference").is_some()
        );
        for needle in [
            "must-never-cross",
            "password",
            "secretvalue",
            "secretcontents",
        ] {
            assert!(
                !json.to_ascii_lowercase().contains(needle),
                "leaked secret material: {needle}"
            );
        }
    }

    #[test]
    fn config_get_public_surfaces_load_failure_as_command_error() {
        let directory = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            data_directory: directory.path().join("data"),
            logs_directory: directory.path().join("logs"),
            config_path: directory.path().join("config.json"),
        };
        std::fs::write(&paths.config_path, "not-json").unwrap();
        let state = AppState::initialize(paths, Arc::new(MemorySecretStore::default())).unwrap();

        let json = serde_json::to_string(&public_config(&state)).unwrap();
        assert!(json.contains("\"ok\":false"));
        assert!(json.contains("CONFIG_INVALID"));
    }

    #[test]
    fn service_errors_preserve_field_and_retry_contracts() {
        let provider = serde_json::to_value(provider_service_error::<()>(
            ProviderServiceError::InvalidId,
        ))
        .unwrap();
        assert_eq!(provider["error"]["field"], "id");
        let route = serde_json::to_value(route_service_error::<()>(
            VoiceRouteServiceError::FieldsInvalid,
        ))
        .unwrap();
        assert_eq!(route["error"]["field"], "route");
        let timeout = serde_json::to_value(provider_service_error::<()>(
            ProviderServiceError::Provider(ProviderError::Timeout),
        ))
        .unwrap();
        assert_eq!(timeout["error"]["retryable"], true);
        let review = serde_json::to_value(role_service_error::<()>(
            RoleProfileServiceError::ReviewRequired,
        ))
        .unwrap();
        assert_eq!(review["error"]["code"], "ROLE_PROFILE_REVIEW_REQUIRED");
        assert_eq!(review["error"]["field"], "id");
        assert!(
            review["error"]["message"]
                .as_str()
                .unwrap()
                .contains("save")
        );
        assert!(
            !review["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Ask one question")
        );
        let embedding = serde_json::to_value(embedding_service_error::<()>(
            EmbeddingServiceError::FieldsInvalid,
        ))
        .unwrap();
        assert_eq!(embedding["error"]["field"], "dimensions");
        let livekit =
            serde_json::to_value(livekit_service_error::<()>(LiveKitSettingsError::NotReady))
                .unwrap();
        assert_eq!(livekit["error"]["code"], "LIVEKIT_NOT_READY");
        assert_eq!(livekit["error"]["retryable"], false);
    }

    #[test]
    fn restore_commands_take_the_service_guard() {
        let source = include_str!("commands.rs");
        let last_good = source
            .split("pub fn config_restore_last_good")
            .nth(1)
            .unwrap()
            .split("pub fn config_restore_defaults")
            .next()
            .unwrap();
        let defaults = source
            .split("pub fn config_restore_defaults")
            .nth(1)
            .unwrap()
            .split("pub fn open_app_directory")
            .next()
            .unwrap();
        assert!(last_good.contains("service_guard"));
        assert!(defaults.contains("service_guard"));
    }

    #[test]
    fn diagnostics_export_omits_role_prompt_bodies() {
        let directory = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            data_directory: directory.path().join("data"),
            logs_directory: directory.path().join("logs"),
            config_path: directory.path().join("config.json"),
        };
        std::fs::write(
            &paths.config_path,
            r#"{
                "configVersion":1,
                "roleProfiles":[{
                    "id":"interviewer",
                    "name":"Interviewer",
                    "systemPrompt":"PROMPT-MARKER-MUST-NOT-EXPORT",
                    "openingMessage":"OPENING-MARKER-MUST-NOT-EXPORT",
                    "styleInstructions":"STYLE-MARKER-MUST-NOT-EXPORT",
                    "active":false,
                    "configVersion":1
                }]
            }"#,
        )
        .unwrap();
        let state = AppState::initialize(paths, Arc::new(MemorySecretStore::default())).unwrap();
        let config = state.config.load().unwrap();
        let public = serde_json::to_string(&crate::config::public_view(&config)).unwrap();
        assert!(public.contains("PROMPT-MARKER-MUST-NOT-EXPORT"));
        assert!(public.contains("OPENING-MARKER-MUST-NOT-EXPORT"));
        assert!(public.contains("STYLE-MARKER-MUST-NOT-EXPORT"));
        let destination = directory.path().join("report.json");
        state
            .diagnostics
            .export(
                &destination,
                serde_json::to_value(crate::config::diagnostic_view(&config)).unwrap(),
                serde_json::json!({ "database": "ready" }),
            )
            .unwrap();
        let report = std::fs::read_to_string(destination).unwrap();
        assert!(!report.contains("PROMPT-MARKER-MUST-NOT-EXPORT"));
        assert!(!report.contains("OPENING-MARKER-MUST-NOT-EXPORT"));
        assert!(!report.contains("STYLE-MARKER-MUST-NOT-EXPORT"));
        assert!(!report.contains("systemPrompt"));
        assert!(!report.contains("openingMessage"));
        assert!(!report.contains("styleInstructions"));
        assert!(report.contains("interviewer"));
    }

    fn material_paths(directory: &tempfile::TempDir) -> AppPaths {
        AppPaths {
            data_directory: directory.path().join("data"),
            logs_directory: directory.path().join("logs"),
            config_path: directory.path().join("config.json"),
        }
    }

    fn material_state(directory: &tempfile::TempDir) -> AppState {
        let paths = material_paths(directory);
        std::fs::write(&paths.config_path, r#"{"configVersion":1}"#).unwrap();
        AppState::initialize(paths, Arc::new(MemorySecretStore::default())).unwrap()
    }

    fn command_error_code<T: serde::Serialize + ts_rs::TS>(
        result: &crate::contracts::CommandResult<T>,
    ) -> String {
        let value = serde_json::to_value(result).unwrap();
        value["error"]["code"].as_str().unwrap().to_owned()
    }

    fn command_error_message<T: serde::Serialize + ts_rs::TS>(
        result: &crate::contracts::CommandResult<T>,
    ) -> String {
        let value = serde_json::to_value(result).unwrap();
        value["error"]["message"].as_str().unwrap().to_owned()
    }

    #[test]
    fn material_write_commands_take_the_service_guard() {
        let source = include_str!("commands.rs");
        let import = source
            .split("pub fn material_import")
            .nth(1)
            .expect("material_import command")
            .split("pub fn material_search")
            .next()
            .unwrap();
        let delete = source
            .split("pub fn material_delete")
            .nth(1)
            .expect("material_delete command")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(import.contains("service_guard"));
        assert!(delete.contains("service_guard"));
    }

    #[test]
    fn material_read_commands_skip_the_service_guard() {
        let source = include_str!("commands.rs");
        let list = source
            .split("pub fn material_list")
            .nth(1)
            .expect("material_list command")
            .split("pub fn material_import")
            .next()
            .unwrap();
        let search = source
            .split("pub fn material_search")
            .nth(1)
            .expect("material_search command")
            .split("pub fn material_delete")
            .next()
            .unwrap();
        assert!(!list.contains("service_guard"));
        assert!(!search.contains("service_guard"));
    }

    #[test]
    fn material_import_rejects_relative_missing_and_directory_paths() {
        let directory = tempfile::tempdir().unwrap();
        let state = material_state(&directory);
        let relative = super::material_import_cmd(&state, "notes.txt".into());
        assert_eq!(command_error_code(&relative), "MATERIAL_PATH_INVALID");
        assert!(!command_error_message(&relative).contains("notes.txt"));

        let missing = directory.path().join("missing.txt");
        let missing = super::material_import_cmd(&state, missing.to_string_lossy().into_owned());
        assert_eq!(command_error_code(&missing), "MATERIAL_PATH_INVALID");

        let folder = directory.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        let as_dir = super::material_import_cmd(&state, folder.to_string_lossy().into_owned());
        assert_eq!(command_error_code(&as_dir), "MATERIAL_PATH_INVALID");
        assert!(!command_error_message(&as_dir).contains("SELECT"));
    }

    #[test]
    fn material_commands_fail_closed_when_database_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        let state = material_state(&directory);
        *state.database.lock().unwrap() = None;
        let listed = super::material_list_cmd(&state);
        assert_eq!(command_error_code(&listed), "DATABASE_OPERATION_FAILED");
        let searched = super::material_search_cmd(&state, "订单服务".into(), None);
        assert_eq!(command_error_code(&searched), "DATABASE_OPERATION_FAILED");
    }

    #[test]
    fn material_commands_list_import_search_and_delete() {
        let directory = tempfile::tempdir().unwrap();
        let state = material_state(&directory);
        let source = directory.path().join("resume.md");
        std::fs::write(
            &source,
            "工作经历\n2019.03-2021.06 阿里巴巴 高级工程师\n负责订单服务与 Kafka 链路。",
        )
        .unwrap();

        let imported = serde_json::to_value(super::material_import_cmd(
            &state,
            source.to_string_lossy().into_owned(),
        ))
        .unwrap();
        assert_eq!(imported["ok"], true);
        assert_eq!(imported["data"]["fileName"], "resume.md");
        assert!(imported["data"].get("extractedText").is_none());
        let id = imported["data"]["id"].as_str().unwrap().to_owned();

        let listed = serde_json::to_value(super::material_list_cmd(&state)).unwrap();
        assert_eq!(listed["ok"], true);
        assert_eq!(listed["data"][0]["id"], id);
        assert!(listed["data"][0].get("extractedText").is_none());

        let hits =
            serde_json::to_value(super::material_search_cmd(&state, "订单服务".into(), None))
                .unwrap();
        assert_eq!(hits["ok"], true);
        assert_eq!(hits["data"][0]["materialId"], id);
        assert!(
            hits["data"][0]["snippet"]
                .as_str()
                .unwrap()
                .contains("订单服务")
        );
        assert!(hits["data"][0].get("extractedText").is_none());

        let operators = serde_json::to_value(super::material_search_cmd(
            &state,
            "订单服务 OR".into(),
            Some(5),
        ))
        .unwrap();
        assert_eq!(operators["ok"], true);
        assert_ne!(operators["error"]["code"], "MATERIAL_OPERATION_FAILED");

        let deleted = serde_json::to_value(super::material_delete_cmd(&state, id)).unwrap();
        assert_eq!(deleted["ok"], true);
        assert_eq!(deleted["data"]["ready"], true);
        let empty = serde_json::to_value(super::material_list_cmd(&state)).unwrap();
        assert_eq!(empty["data"].as_array().unwrap().len(), 0);
    }

    fn command_body<'a>(source: &'a str, name: &str) -> &'a str {
        source
            .split(&format!("pub fn {name}"))
            .nth(1)
            .unwrap_or_else(|| panic!("missing command {name}"))
    }

    #[test]
    fn session_mutating_commands_take_the_service_guard() {
        let source = include_str!("commands.rs");
        for name in [
            "session_start",
            "session_stop",
            "session_delete",
            "session_export",
            "session_finalize_utterance",
        ] {
            assert!(
                command_body(source, name).contains("service_guard"),
                "{name} must take service_guard"
            );
        }
    }

    #[test]
    fn session_read_and_mode_commands_skip_the_service_guard() {
        let source = include_str!("commands.rs");
        for name in [
            "session_list",
            "session_get",
            "session_set_mode",
            "runtime_get_status",
        ] {
            let body = command_body(source, name);
            let until_next = body
                .split("\nfn ")
                .next()
                .and_then(|chunk| chunk.split("\npub fn ").next())
                .unwrap_or(body);
            assert!(
                !until_next.contains("service_guard"),
                "{name} must not take service_guard"
            );
        }
    }

    fn ready_session_config() -> String {
        r#"{
            "configVersion":1,
            "models":{"providers":[
                {"id":"asr-1","baseUrl":"https://asr.example.test/v1","credential":{"reference":"providers/asr-1/api-key","configured":true}},
                {"id":"llm-1","baseUrl":"https://llm.example.test/v1","credential":{"reference":"providers/llm-1/api-key","configured":true}},
                {"id":"tts-1","baseUrl":"https://tts.example.test/v1","credential":{"reference":"providers/tts-1/api-key","configured":true}}
            ]},
            "speech":{"voiceRoutes":[{
                "id":"route-1","name":"Default","mode":"cascaded",
                "asrProviderId":"asr-1","asrModelId":"whisper",
                "llmProviderId":"llm-1","llmModelId":"gpt",
                "ttsProviderId":"tts-1","ttsModelId":"tts-model",
                "voiceId":"alloy","active":true,"ready":true,"status":"ready","configVersion":1
            }],"activeVoiceRouteId":"route-1"},
            "roleProfiles":[{
                "id":"role-1","name":"Interviewer",
                "systemPrompt":"PROMPT-BODY","openingMessage":"OPENING-BODY","styleInstructions":"STYLE-BODY",
                "active":true,"configVersion":1
            }],
            "activeRoleProfileId":"role-1"
        }"#
        .into()
    }

    fn session_state(directory: &tempfile::TempDir, config: &str) -> AppState {
        let paths = AppPaths {
            data_directory: directory.path().join("data"),
            logs_directory: directory.path().join("logs"),
            config_path: directory.path().join("config.json"),
        };
        std::fs::write(&paths.config_path, config).unwrap();
        AppState::initialize(paths, Arc::new(MemorySecretStore::default())).unwrap()
    }

    #[test]
    fn session_start_returns_blocked_or_started_without_secret_or_pcm() {
        let empty_dir = tempfile::tempdir().unwrap();
        let empty = session_state(&empty_dir, r#"{"configVersion":1}"#);
        let blocked = serde_json::to_value(super::session_start_cmd(&empty)).unwrap();
        assert_eq!(blocked["ok"], true);
        assert_eq!(blocked["data"]["kind"], "blocked");
        assert!(blocked["data"]["issues"].as_array().unwrap().len() >= 2);
        assert!(!serde_json::to_string(&blocked).unwrap().contains("pcm"));

        let ready_dir = tempfile::tempdir().unwrap();
        let ready = session_state(&ready_dir, &ready_session_config());
        let started = serde_json::to_value(super::session_start_cmd(&ready)).unwrap();
        assert_eq!(started["ok"], true, "{started}");
        assert_eq!(started["data"]["kind"], "started");
        assert_eq!(started["data"]["session"]["status"], "listening");
        assert_eq!(started["data"]["session"]["transportMode"], "direct");
        let json = serde_json::to_string(&started).unwrap();
        assert!(!json.contains("PROMPT-BODY"));
        assert!(!json.contains("pcm"));
        assert!(!json.to_ascii_lowercase().contains("sk-"));
    }

    #[test]
    fn session_commands_list_get_export_delete_and_status() {
        let directory = tempfile::tempdir().unwrap();
        let state = session_state(&directory, &ready_session_config());
        let started = serde_json::to_value(super::session_start_cmd(&state)).unwrap();
        let id = started["data"]["session"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let listed = serde_json::to_value(super::session_list_cmd(&state)).unwrap();
        assert_eq!(listed["ok"], true);
        assert_eq!(listed["data"][0]["id"], id);

        let detail = serde_json::to_value(super::session_get_cmd(&state, id.clone())).unwrap();
        assert_eq!(detail["ok"], true);
        assert_eq!(detail["data"]["session"]["id"], id);
        assert!(detail["data"]["turns"].as_array().unwrap().is_empty());
        assert!(detail["data"].get("extractedText").is_none());

        let exported = serde_json::to_value(super::session_export_cmd(
            &state,
            id.clone(),
            "markdown".into(),
        ))
        .unwrap();
        assert_eq!(exported["ok"], true);
        let path = exported["data"]["path"].as_str().unwrap();
        assert!(path.contains("exports"));
        assert!(std::path::Path::new(path).is_file());
        let export_text = std::fs::read_to_string(path).unwrap();
        assert!(export_text.contains(&id));
        assert!(!export_text.contains("PROMPT-BODY"));

        let status = serde_json::to_value(super::runtime_get_status_cmd(&state)).unwrap();
        assert_eq!(status["ok"], true);
        assert_eq!(status["data"]["phase"], "listening");
        assert_eq!(status["data"]["mode"], "ai_active");
        assert!(status["data"]["seq"].as_u64().is_some());
        assert_eq!(status["data"]["unusedMaterials"], false);
        assert!(status["data"]["lastErrorCode"].is_null());

        let mode = serde_json::to_value(super::session_set_mode_cmd(
            &state,
            "operator_speaking".into(),
        ))
        .unwrap();
        assert_eq!(mode["ok"], true);
        assert_eq!(mode["data"]["mode"], "operator_speaking");

        let deleted = serde_json::to_value(super::session_delete_cmd(&state, id)).unwrap();
        assert_eq!(deleted["ok"], true);
        let empty = serde_json::to_value(super::session_list_cmd(&state)).unwrap();
        assert_eq!(empty["data"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn session_stop_keeps_failed_status() {
        let directory = tempfile::tempdir().unwrap();
        let state = session_state(&directory, &ready_session_config());
        assert_eq!(
            serde_json::to_value(super::session_start_cmd(&state)).unwrap()["ok"],
            true
        );
        {
            let db = state.database.lock().unwrap();
            let mut sessions = state.sessions.lock().unwrap();
            sessions.capture().mark_sidecar_exited();
            sessions.poll_sidecar(db.as_ref().unwrap()).unwrap();
            sessions.capture().mark_sidecar_exited();
            let error = sessions
                .poll_sidecar(db.as_ref().unwrap())
                .expect_err("second crash");
            assert_eq!(error.code(), "SESSION_SIDECAR_FAILED");
        }
        let stopped = serde_json::to_value(super::session_stop_cmd(&state)).unwrap();
        assert_eq!(stopped["ok"], true);
        assert_eq!(stopped["data"]["status"], "failed");
    }

    #[test]
    fn session_event_payloads_carry_incrementing_seq_without_pcm() {
        let first = super::runtime_status_event(1, "listening", "ai_active", false, None);
        let second = super::transcript_event(2, "hello");
        let third = super::reply_event(3, "world");
        let level = super::audio_level_event(4, 0.42);
        assert_eq!(first["seq"], 1);
        assert_eq!(second["seq"], 2);
        assert_eq!(third["seq"], 3);
        assert_eq!(level["seq"], 4);
        assert_eq!(level["peak"], 0.42);
        for payload in [first, second, third, level] {
            let json = payload.to_string();
            assert!(!json.contains("pcm"));
            assert!(!json.contains("extractedText"));
        }
        assert_eq!(
            super::transcript_event(5, &"x".repeat(200))["text"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            160
        );
    }

    #[test]
    fn finalize_event_seqs_bump_separately() {
        let directory = tempfile::tempdir().unwrap();
        let state = session_state(&directory, &ready_session_config());
        let first = super::bump_event_seq(&state);
        let second = super::bump_event_seq(&state);
        assert_eq!(second, first + 1);
        assert_ne!(first, second);
    }

    struct ScriptedAsr;
    struct ScriptedLlm(&'static str);
    struct ScriptedTts;
    struct UnusedEmbed;

    impl crate::providers::SpeechToText for ScriptedAsr {
        fn transcribe(
            &self,
            _: &crate::providers::ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: &[u8],
            _: u32,
        ) -> Result<String, crate::providers::CascadeError> {
            Ok("ignored".into())
        }
    }

    impl crate::providers::ChatModel for ScriptedLlm {
        fn complete(
            &self,
            _: &crate::providers::ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: &[crate::providers::ChatMessage],
        ) -> Result<String, crate::providers::CascadeError> {
            Ok(self.0.into())
        }
    }

    impl crate::providers::TextToSpeech for ScriptedTts {
        fn synthesize(
            &self,
            _: &crate::providers::ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<Vec<u8>, crate::providers::CascadeError> {
            Ok(vec![0x01, 0x02])
        }
    }

    impl crate::providers::EmbeddingProbe for UnusedEmbed {
        fn embed(
            &self,
            _: &crate::providers::ProviderEndpoint,
            _: Option<&str>,
            _: &str,
            _: u32,
            _: &str,
        ) -> Result<Vec<f32>, crate::providers::EmbeddingError> {
            Err(crate::providers::EmbeddingError::RequestFailed)
        }
    }

    #[test]
    fn session_finalize_utterance_persists_turn_without_pcm() {
        let directory = tempfile::tempdir().unwrap();
        let state = session_state(&directory, &ready_session_config());
        assert_eq!(
            serde_json::to_value(super::session_start_cmd(&state)).unwrap()["ok"],
            true
        );
        let asr = ScriptedAsr;
        let llm = ScriptedLlm("这是一个后端岗位");
        let tts = ScriptedTts;
        let embed = UnusedEmbed;
        let probes = crate::services::SessionProbes {
            asr: &asr,
            llm: &llm,
            tts: &tts,
            embed: &embed,
        };
        let finalized = serde_json::to_value(super::session_finalize_utterance_cmd(
            &state,
            &probes,
            crate::runtime::CascadeCredentials::default(),
            Some("请介绍岗位"),
        ))
        .unwrap();
        assert_eq!(finalized["ok"], true, "{finalized}");
        assert_eq!(finalized["data"]["userText"], "请介绍岗位");
        assert_eq!(finalized["data"]["assistantText"], "这是一个后端岗位");
        assert_eq!(finalized["data"]["materialsUsed"], false);
        let json = finalized.to_string();
        assert!(!json.contains("pcm"));
        assert!(!json.contains("extractedText"));

        let id = serde_json::to_value(super::session_list_cmd(&state)).unwrap()["data"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let detail = serde_json::to_value(super::session_get_cmd(&state, id)).unwrap();
        assert_eq!(detail["data"]["turns"].as_array().unwrap().len(), 1);
        assert_eq!(
            detail["data"]["turns"][0]["assistantText"],
            "这是一个后端岗位"
        );

        let missing = serde_json::to_value(super::session_finalize_utterance_cmd(
            &session_state(&tempfile::tempdir().unwrap(), &ready_session_config()),
            &probes,
            crate::runtime::CascadeCredentials::default(),
            Some("hi"),
        ))
        .unwrap();
        assert_eq!(missing["ok"], false);
        assert_eq!(missing["error"]["code"], "SESSION_NOT_FOUND");
    }
}
