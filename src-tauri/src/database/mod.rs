use std::{path::Path, sync::Mutex, time::Duration};

#[cfg(test)]
use rusqlite::OptionalExtension;
use rusqlite::{Connection, params};
use thiserror::Error;

const LATEST_SCHEMA_VERSION: i64 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const FOUNDATION_MIGRATION: &str = include_str!("../../migrations/0001_foundation.sql");

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error("Database schema is newer than this application")]
    NewerVersion,
    #[error("Database operation failed")]
    Operation,
}

impl DatabaseError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NewerVersion => "DATABASE_VERSION_NEWER",
            Self::Operation => "DATABASE_OPERATION_FAILED",
        }
    }
}

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DatabaseError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).map_err(|_| DatabaseError::Operation)?;
        }
        let connection = Connection::open(path).map_err(|_| DatabaseError::Operation)?;
        connection
            .busy_timeout(BUSY_TIMEOUT)
            .map_err(|_| DatabaseError::Operation)?;
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|_| DatabaseError::Operation)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn migrate(&self) -> Result<(), DatabaseError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| DatabaseError::Operation)?;
        let has_migrations: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations')",
            [],
            |row| row.get(0),
        ).map_err(|_| DatabaseError::Operation)?;
        let current = if has_migrations {
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, Option<i64>>(0)
                })
                .map_err(|_| DatabaseError::Operation)?
                .unwrap_or(0)
        } else {
            0
        };
        if current > LATEST_SCHEMA_VERSION {
            return Err(DatabaseError::NewerVersion);
        }
        if current == 0 {
            let transaction = connection
                .transaction()
                .map_err(|_| DatabaseError::Operation)?;
            transaction
                .execute_batch(FOUNDATION_MIGRATION)
                .map_err(|_| DatabaseError::Operation)?;
            transaction
                .execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                    params![LATEST_SCHEMA_VERSION, chrono::Utc::now().to_rfc3339()],
                )
                .map_err(|_| DatabaseError::Operation)?;
            transaction.commit().map_err(|_| DatabaseError::Operation)?;
        }
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<String, DatabaseError> {
        self.pragma_string("integrity_check")
    }

    #[cfg(test)]
    pub fn busy_timeout(&self) -> Duration {
        BUSY_TIMEOUT
    }

    #[cfg(test)]
    fn schema_version(&self) -> Result<i64, DatabaseError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatabaseError::Operation)?;
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .optional()
            .map_err(|_| DatabaseError::Operation)?
            .flatten()
            .ok_or(DatabaseError::Operation)
    }

    fn pragma_string(&self, name: &str) -> Result<String, DatabaseError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatabaseError::Operation)?;
        connection
            .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
            .map_err(|_| DatabaseError::Operation)
    }

    #[cfg(test)]
    fn pragma_i64(&self, name: &str) -> Result<i64, DatabaseError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatabaseError::Operation)?;
        connection
            .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
            .map_err(|_| DatabaseError::Operation)
    }

    #[cfg(test)]
    fn table_names(&self) -> Result<Vec<String>, DatabaseError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatabaseError::Operation)?;
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).map_err(|_| DatabaseError::Operation)?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|_| DatabaseError::Operation)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| DatabaseError::Operation)
    }

    #[cfg(test)]
    fn column_names(&self) -> Result<Vec<String>, DatabaseError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| DatabaseError::Operation)?;
        let mut statement = connection.prepare(
            "SELECT p.name FROM sqlite_schema AS s JOIN pragma_table_info(s.name) AS p WHERE s.type='table'",
        ).map_err(|_| DatabaseError::Operation)?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|_| DatabaseError::Operation)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| DatabaseError::Operation)
    }
}

#[cfg(test)]
mod tests;
