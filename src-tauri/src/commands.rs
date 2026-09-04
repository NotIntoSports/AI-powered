use crate::contracts::{CommandResult, FoundationStatus};

#[tauri::command]
pub fn foundation_get_status() -> CommandResult<FoundationStatus> {
    CommandResult::Ok {
        data: FoundationStatus { ready: true },
    }
}
