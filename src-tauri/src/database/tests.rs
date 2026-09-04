use std::time::Duration;

use rusqlite::Connection;

use super::Database;

fn database() -> (tempfile::TempDir, Database) {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(directory.path().join("app.sqlite3")).unwrap();
    (directory, database)
}

#[test]
fn empty_database_migrates_once_and_passes_integrity_check() {
    let (_directory, database) = database();
    database.migrate().unwrap();
    database.migrate().unwrap();

    assert_eq!(database.schema_version().unwrap(), 1);
    assert_eq!(database.integrity_check().unwrap(), "ok");
    assert_eq!(
        database.table_names().unwrap(),
        vec!["app_preferences", "diagnostic_events", "schema_migrations",]
    );
}

#[test]
fn connection_enables_required_sqlite_safety_settings() {
    let (_directory, database) = database();
    assert_eq!(database.pragma_string("journal_mode").unwrap(), "wal");
    assert_eq!(database.pragma_i64("foreign_keys").unwrap(), 1);
    assert_eq!(database.pragma_i64("busy_timeout").unwrap(), 5_000);
}

#[test]
fn future_schema_version_fails_closed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("future.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
         INSERT INTO schema_migrations(version, applied_at) VALUES (99, 'future');",
    ).unwrap();
    drop(connection);

    let database = Database::open(path).unwrap();
    assert_eq!(
        database.migrate().unwrap_err().code(),
        "DATABASE_VERSION_NEWER"
    );
}

#[test]
fn foundation_schema_cannot_store_secret_named_columns() {
    let (_directory, database) = database();
    database.migrate().unwrap();
    let forbidden = database
        .column_names()
        .unwrap()
        .into_iter()
        .filter(|name| {
            let name = name.to_ascii_lowercase();
            ["api_key", "token", "secret", "password"]
                .iter()
                .any(|part| name.contains(part))
        })
        .collect::<Vec<_>>();
    assert!(
        forbidden.is_empty(),
        "forbidden secret columns: {forbidden:?}"
    );
}

#[test]
fn configured_busy_timeout_matches_five_seconds() {
    let (_directory, database) = database();
    assert_eq!(database.busy_timeout(), Duration::from_secs(5));
}
