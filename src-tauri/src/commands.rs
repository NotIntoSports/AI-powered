use tauri::State;

use crate::{
    app_state::AppState,
    config::{ProviderConfig, PublicConfig, VoiceRouteConfig, public_view},
    contracts::{CommandResult, DiagnosticsExportResult, FoundationStatus, StartupState},
    error::PublicError,
    providers::OpenAiCompatibleProbe,
    services::{
        ModelDiscoveryResult, ProviderSaveInput, ProviderService, ProviderServiceError,
        ProviderTestResult, VoiceRouteSaveInput, VoiceRouteService, VoiceRouteServiceError,
        VoiceRouteTestResult,
    },
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
        Ok(config) => match serde_json::to_value(config) {
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

#[tauri::command]
pub fn config_restore_last_good(state: State<'_, AppState>) -> CommandResult<StartupState> {
    CommandResult::Ok {
        data: state.restore_last_good(),
    }
}

#[tauri::command]
pub fn config_restore_defaults(state: State<'_, AppState>) -> CommandResult<StartupState> {
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

    use super::{provider_service_error, public_config, route_service_error};
    use crate::{
        app_state::{AppPaths, AppState},
        providers::ProviderError,
        secrets::MemorySecretStore,
        services::{ProviderServiceError, VoiceRouteServiceError},
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
        // The command returns the redacted PublicConfig: ok=true with the credential
        // surviving only as a SecretSlot reference + configured flag.
        assert!(json.contains("\"ok\":true"));
        assert!(json.contains("\"configVersion\":1"));
        assert!(json.contains("providers/p1/api-key"));
        assert!(json.contains("\"configured\":true"));
        // No secret material keyword crosses the IPC boundary.
        let lower = json.to_ascii_lowercase();
        for needle in [
            "apikey",
            "password",
            "secretvalue",
            "secretcontents",
            "token",
        ] {
            assert!(!lower.contains(needle), "leaked secret material: {needle}");
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
    }
}
