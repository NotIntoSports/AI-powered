use std::{path::Path, sync::Arc};

use crate::{
    database::{Database, DatabaseError},
    secrets::{SecretService, WindowsSecretStore},
};

pub struct AppState {
    pub secrets: SecretService,
    pub database: Database,
}

impl AppState {
    pub fn production(data_directory: &Path) -> Result<Self, DatabaseError> {
        let database = Database::open(data_directory.join("app.sqlite3"))?;
        database.migrate()?;
        Ok(Self {
            secrets: SecretService::new("default", Arc::new(WindowsSecretStore::new()))
                .expect("static secret namespace must be valid"),
            database,
        })
    }
}
