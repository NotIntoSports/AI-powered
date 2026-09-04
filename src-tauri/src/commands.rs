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
