use std::{path::Path, sync::Arc};

use crate::{
    config::ConfigStore,
    database::{Database, DatabaseError},
    diagnostics::{DiagnosticError, DiagnosticWriter},
    secrets::{SecretService, WindowsSecretStore},
};

pub struct AppState {
    pub secrets: SecretService,
    pub database: Database,
    pub diagnostics: DiagnosticWriter,
    pub config: ConfigStore,
}

#[derive(Debug, thiserror::Error)]
pub enum AppStateError {
    #[error(transparent)]
    Database(#[from] DatabaseError),
    #[error(transparent)]
    Diagnostics(#[from] DiagnosticError),
}

impl AppState {
    pub fn production(data_directory: &Path) -> Result<Self, AppStateError> {
        let diagnostics = DiagnosticWriter::new(data_directory.join("logs"))?;
        let database = Database::open(data_directory.join("app.sqlite3"))?;
        database.migrate()?;
        Ok(Self {
            secrets: SecretService::new("default", Arc::new(WindowsSecretStore::new()))
                .expect("static secret namespace must be valid"),
            database,
            diagnostics,
            config: ConfigStore::new(data_directory.join("config.json")),
        })
    }
}
