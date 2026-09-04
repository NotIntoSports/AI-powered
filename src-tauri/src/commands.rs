use tauri::State;

use crate::{
    app_state::AppState,
    contracts::{CommandResult, FoundationStatus, SecretStatus},
    error::PublicError,
    secrets::SecretError,
};

#[tauri::command]
pub fn foundation_get_status() -> CommandResult<FoundationStatus> {
    CommandResult::Ok {
        data: FoundationStatus { ready: true },
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
