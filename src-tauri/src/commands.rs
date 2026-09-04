use tauri::State;

use crate::{
    app_state::AppState,
    contracts::{
        CommandResult, DiagnosticsExportResult, FoundationStatus, SecretStatus, StartupState,
    },
    error::PublicError,
    secrets::SecretError,
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

fn secret_failure(error: SecretError) -> CommandResult<SecretStatus> {
    CommandResult::Err {
        error: PublicError::new(error.code(), error.to_string(), false),
    }
}

#[tauri::command]
pub fn secret_set(
    state: State<'_, AppState>,
    reference: String,
    value: String,
) -> CommandResult<SecretStatus> {
    state
        .secrets
        .set(&reference, &value)
        .map_or_else(secret_failure, |data| CommandResult::Ok { data })
}

#[tauri::command]
pub fn secret_delete(state: State<'_, AppState>, reference: String) -> CommandResult<SecretStatus> {
    state
        .secrets
        .delete(&reference)
        .map_or_else(secret_failure, |data| CommandResult::Ok { data })
}

#[tauri::command]
pub fn secret_status(
    state: State<'_, AppState>,
    references: Vec<String>,
) -> CommandResult<Vec<SecretStatus>> {
    match state.secrets.statuses(&references) {
        Ok(data) => CommandResult::Ok { data },
        Err(error) => CommandResult::Err {
            error: PublicError::new(error.code(), error.to_string(), false),
        },
    }
}
