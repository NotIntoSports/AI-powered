use std::path::{Path, PathBuf};

use crate::database::DatabaseError;
use crate::sessions::{SessionStore, SessionTurn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionExportFormat {
    Markdown,
    Json,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionExportError {
    NotFound,
    FormatInvalid,
    WriteFailed,
    Database,
}

impl SessionExportError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "SESSION_NOT_FOUND",
            Self::FormatInvalid => "SESSION_EXPORT_FORMAT_INVALID",
            Self::WriteFailed => "SESSION_EXPORT_FAILED",
            Self::Database => "DATABASE_OPERATION_FAILED",
        }
    }
}

impl From<DatabaseError> for SessionExportError {
    fn from(_: DatabaseError) -> Self {
        Self::Database
    }
}

impl SessionExportFormat {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "markdown" => Some(Self::Markdown),
            "json" => Some(Self::Json),
            "text" => Some(Self::Text),
            _ => None,
        }
    }

    pub const fn extension(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Json => "json",
            Self::Text => "txt",
        }
    }
}

pub fn export_session(
    store: &SessionStore<'_>,
    session_id: &str,
    format: SessionExportFormat,
    export_root: &Path,
) -> Result<PathBuf, SessionExportError> {
    let session = store.get(session_id)?.ok_or(SessionExportError::NotFound)?;
    let turns = store.list_turns(session_id)?;
    let body = render_export(&session.id, &session.status, &turns, format);
    std::fs::create_dir_all(export_root).map_err(|_| SessionExportError::WriteFailed)?;
    let path = export_root.join(format!("{session_id}.{}", format.extension()));
    std::fs::write(&path, body).map_err(|_| SessionExportError::WriteFailed)?;
    Ok(path)
}

fn render_export(
    session_id: &str,
    status: &str,
    turns: &[SessionTurn],
    format: SessionExportFormat,
) -> String {
    match format {
        SessionExportFormat::Json => {
            let turns = turns
                .iter()
                .map(|turn| {
                    serde_json::json!({
                        "turnIndex": turn.turn_index,
                        "userText": turn.user_text,
                        "assistantText": turn.assistant_text,
                        "materialsUsed": turn.materials_used,
                    })
                })
                .collect::<Vec<_>>();
            serde_json::json!({
                "schemaVersion": 1,
                "id": session_id,
                "status": status,
                "turns": turns,
            })
            .to_string()
        }
        SessionExportFormat::Markdown => {
            let mut body = format!("# Session {session_id}\n\nstatus: {status}\n");
            for turn in turns {
                body.push_str(&format!(
                    "\n## Turn {}\n\n**user**: {}\n\n**assistant**: {}\n",
                    turn.turn_index, turn.user_text, turn.assistant_text
                ));
            }
            body
        }
        SessionExportFormat::Text => {
            let mut body = format!("Session {session_id}\nstatus: {status}\n");
            for turn in turns {
                body.push_str(&format!(
                    "\nTurn {}\nuser: {}\nassistant: {}\n",
                    turn.turn_index, turn.user_text, turn.assistant_text
                ));
            }
            body
        }
    }
}
