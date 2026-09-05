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

    assert_eq!(database.schema_version().unwrap(), 2);
    assert_eq!(database.integrity_check().unwrap(), "ok");
    assert_eq!(
        database.application_table_names().unwrap(),
        vec![
            "app_preferences",
            "diagnostic_events",
            "embedding_spaces",
            "material_chunks",
            "material_chunks_fts",
            "material_documents",
            "material_file_cleanup",
            "materials",
            "schema_migrations",
        ]
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

#[test]
fn foundation_database_migrates_to_materials_schema() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("v1.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(include_str!("../../migrations/0001_foundation.sql"))
        .unwrap();
    connection
        .execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-09-04T00:00:00Z')",
            [],
        )
        .unwrap();
    drop(connection);

    let database = Database::open(path).unwrap();
    database.migrate().unwrap();

    assert_eq!(database.schema_version().unwrap(), 2);
    assert!(database
        .application_table_names()
        .unwrap()
        .contains(&"materials".to_owned()));
}

#[test]
fn materials_fts5_matches_chinese_trigrams() {
    let (_directory, database) = database();
    database.migrate().unwrap();
    database
        .execute_batch(
            "INSERT INTO material_chunks_fts(content, material_id, chunk_id)
             VALUES ('负责订单服务与 Kafka 链路', 'material-1', 'chunk-1');",
        )
        .unwrap();

    assert_eq!(
        database
            .query_string(
                "SELECT chunk_id FROM material_chunks_fts WHERE material_chunks_fts MATCH '订单服务'"
            )
            .unwrap(),
        "chunk-1"
    );
}
