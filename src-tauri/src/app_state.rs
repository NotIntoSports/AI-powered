use std::sync::Arc;

use crate::secrets::{SecretService, WindowsSecretStore};

pub struct AppState {
    pub secrets: SecretService,
}

impl AppState {
    pub fn production() -> Self {
        Self {
            secrets: SecretService::new("default", Arc::new(WindowsSecretStore::new()))
                .expect("static secret namespace must be valid"),
        }
    }
}
