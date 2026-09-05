use std::{
    path::PathBuf,
    sync::{Arc, Mutex, RwLock, atomic::AtomicU64},
};

use crate::{
    config::{ConfigLoadOutcome, ConfigStore},
    contracts::StartupState,
    database::{Database, DatabaseError},
    diagnostics::{DiagnosticError, DiagnosticWriter},
    error::PublicError,
    secrets::{SecretService, SecretStore, WindowsSecretStore},
    services::SessionService,
    sessions::SessionStore,
};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_directory: PathBuf,
    pub logs_directory: PathBuf,
    pub config_path: PathBuf,
}

pub struct AppState {
    pub secrets: SecretService,
    pub database: Mutex<Option<Database>>,
    pub diagnostics: DiagnosticWriter,
    pub config: ConfigStore,
    pub service_lock: Mutex<()>,
    pub sessions: Mutex<SessionService>,
    pub event_seq: AtomicU64,
    database_path: PathBuf,
    secret_backend_ready: bool,
    startup: RwLock<StartupState>,
    pub paths: AppPaths,
}

#[derive(Debug, thiserror::Error)]
pub enum AppStateError {
    #[error(transparent)]
    Diagnostics(#[from] DiagnosticError),
}

impl AppState {
    pub fn production(paths: AppPaths) -> Result<Self, AppStateError> {
        Self::initialize(paths, Arc::new(WindowsSecretStore::new()))
    }

    pub fn initialize(
        paths: AppPaths,
        secret_store: Arc<dyn SecretStore>,
    ) -> Result<Self, AppStateError> {
        std::fs::create_dir_all(&paths.data_directory).map_err(|_| DiagnosticError::Operation)?;
        let diagnostics = DiagnosticWriter::new(paths.logs_directory.clone())?;
        let secrets =
            SecretService::new("default", secret_store).expect("static namespace is valid");
        let secret_backend_ready = secrets.status("system/startup-probe").is_ok();
        let config = ConfigStore::new(paths.config_path.clone());
        let mut startup = if secret_backend_ready {
            match config.load_for_startup() {
                Ok(ConfigLoadOutcome::Ready(_)) => StartupState::Ready,
                Ok(ConfigLoadOutcome::Migrated(_)) => StartupState::Migrated,
                Err(error) if config.load_last_good().is_ok() => StartupState::Recoverable {
                    error: public_startup_error(error.code()),
                },
                Err(error) => StartupState::Invalid {
                    error: public_startup_error(error.code()),
                },
            }
        } else {
            StartupState::Invalid {
                error: public_startup_error("SECRET_BACKEND_UNAVAILABLE"),
            }
        };
        let database_path = paths.data_directory.join("app.sqlite3");
        let database = if secret_backend_ready
            && matches!(startup, StartupState::Ready | StartupState::Migrated)
        {
            match open_and_recover(&database_path) {
                Ok(database) => Some(database),
                Err(error) => {
                    startup = StartupState::Invalid {
                        error: public_startup_error(error.code()),
                    };
                    None
                }
            }
        } else {
            None
        };
        Ok(Self {
            secrets,
            database: Mutex::new(database),
            diagnostics,
            config,
            service_lock: Mutex::new(()),
            sessions: Mutex::new(SessionService::new()),
            event_seq: AtomicU64::new(0),
            database_path,
            secret_backend_ready,
            startup: RwLock::new(startup),
            paths,
        })
    }

    pub fn startup_state(&self) -> StartupState {
        self.startup
            .read()
            .map(|state| state.clone())
            .unwrap_or_else(|_| StartupState::Invalid {
                error: public_startup_error("STARTUP_STATE_UNAVAILABLE"),
            })
    }

    pub fn restore_last_good(&self) -> StartupState {
        self.repair_config(|| self.config.restore_last_good())
    }

    pub fn restore_defaults(&self) -> StartupState {
        self.repair_config(|| self.config.restore_defaults())
    }

    fn repair_config(
        &self,
        repair: impl FnOnce() -> Result<crate::config::AppConfigV1, crate::config::ConfigError>,
    ) -> StartupState {
        let next = if !self.secret_backend_ready {
            StartupState::Invalid {
                error: public_startup_error("SECRET_BACKEND_UNAVAILABLE"),
            }
        } else if let Err(error) = repair() {
            StartupState::Invalid {
                error: public_startup_error(error.code()),
            }
        } else {
            match open_and_recover(&self.database_path) {
                Ok(database) => {
                    if let Ok(mut slot) = self.database.lock() {
                        *slot = Some(database);
                    }
                    StartupState::Ready
                }
                Err(error) => StartupState::Invalid {
                    error: public_startup_error(error.code()),
                },
            }
        };
        if let Ok(mut state) = self.startup.write() {
            *state = next.clone();
        }
        next
    }
}

fn open_and_recover(path: &std::path::Path) -> Result<Database, DatabaseError> {
    let database = Database::open(path)?;
    database.migrate()?;
    SessionStore::new(&database).mark_interrupted_open()?;
    Ok(database)
}

fn public_startup_error(code: &str) -> PublicError {
    let message = match code {
        "CONFIG_READ_FAILED" => "无法读取配置文件",
        "CONFIG_BACKUP_READ_FAILED" => "无法读取上次可用配置",
        "CONFIG_VERSION_UNSUPPORTED" => "配置版本不受支持",
        "DATABASE_VERSION_NEWER" => "数据文件来自更新版本的应用",
        "SECRET_BACKEND_UNAVAILABLE" => "Windows 凭据存储不可用",
        _ if code.starts_with("CONFIG_") => "配置格式无效",
        _ if code.starts_with("DATABASE_") => "本地数据库无法初始化",
        _ => "桌面服务无法初始化",
    };
    PublicError::new(code, message, false)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use zeroize::Zeroizing;

    use super::{AppPaths, AppState};
    use crate::{
        contracts::StartupState,
        secrets::{MemorySecretStore, SecretError, SecretStore},
    };

    fn app_paths(directory: &tempfile::TempDir) -> AppPaths {
        AppPaths {
            data_directory: directory.path().join("data"),
            logs_directory: directory.path().join("logs"),
            config_path: directory.path().join("config.json"),
        }
    }

    fn initialize(paths: AppPaths) -> AppState {
        AppState::initialize(paths, Arc::new(MemorySecretStore::default())).unwrap()
    }

    #[test]
    fn startup_state_ready_migrated_and_optional_missing_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let paths = app_paths(&directory);
        std::fs::write(&paths.config_path, r#"{"configVersion":1}"#).unwrap();
        assert!(matches!(
            initialize(paths).startup_state(),
            StartupState::Ready
        ));

        let directory = tempfile::tempdir().unwrap();
        let paths = app_paths(&directory);
        std::fs::write(&paths.config_path, r#"{"configVersion":0}"#).unwrap();
        assert!(matches!(
            initialize(paths).startup_state(),
            StartupState::Migrated
        ));
    }

    #[test]
    fn startup_state_distinguishes_recoverable_and_invalid_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let paths = app_paths(&directory);
        std::fs::write(&paths.config_path, "not-json").unwrap();
        std::fs::write(
            paths.config_path.with_extension("backup.json"),
            r#"{"configVersion":1}"#,
        )
        .unwrap();
        let state = initialize(paths.clone());
        assert!(matches!(
            state.startup_state(),
            StartupState::Recoverable { .. }
        ));
        assert_eq!(
            std::fs::read_to_string(&paths.config_path).unwrap(),
            "not-json"
        );
        assert!(matches!(state.restore_last_good(), StartupState::Ready));
        assert!(state.config.load().is_ok());

        let directory = tempfile::tempdir().unwrap();
        let paths = app_paths(&directory);
        std::fs::write(&paths.config_path, "not-json").unwrap();
        std::fs::write(paths.config_path.with_extension("backup.json"), "also-bad").unwrap();
        assert!(matches!(
            initialize(paths.clone()).startup_state(),
            StartupState::Invalid { .. }
        ));
        let state = initialize(paths);
        assert!(matches!(state.restore_defaults(), StartupState::Ready));

        let directory = tempfile::tempdir().unwrap();
        let paths = app_paths(&directory);
        std::fs::create_dir_all(&paths.config_path).unwrap();
        assert!(matches!(
            initialize(paths).startup_state(),
            StartupState::Invalid { .. }
        ));
    }

    #[test]
    fn startup_state_fails_closed_for_database_and_secret_backend() {
        let directory = tempfile::tempdir().unwrap();
        let paths = app_paths(&directory);
        std::fs::create_dir_all(&paths.data_directory).unwrap();
        let connection =
            rusqlite::Connection::open(paths.data_directory.join("app.sqlite3")).unwrap();
        connection.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT; INSERT INTO schema_migrations VALUES(99, 'future');").unwrap();
        drop(connection);
        assert!(
            matches!(initialize(paths).startup_state(), StartupState::Invalid { ref error } if error.code == "DATABASE_VERSION_NEWER")
        );

        struct MissingBackend;
        impl SecretStore for MissingBackend {
            fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
                Err(SecretError::Backend)
            }
            fn get(&self, _: &str) -> Result<Option<Zeroizing<String>>, SecretError> {
                Err(SecretError::Backend)
            }
            fn delete(&self, _: &str) -> Result<bool, SecretError> {
                Err(SecretError::Backend)
            }
            fn contains(&self, _: &str) -> Result<bool, SecretError> {
                Err(SecretError::Backend)
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::initialize(app_paths(&directory), Arc::new(MissingBackend)).unwrap();
        assert!(
            matches!(state.startup_state(), StartupState::Invalid { ref error } if error.code == "SECRET_BACKEND_UNAVAILABLE")
        );
    }
}
