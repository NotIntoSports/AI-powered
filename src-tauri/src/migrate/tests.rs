use std::{fs, path::Path};

use chrono::{TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};

use super::{
    LegacyKind, LegacySearchRoot, backup_legacy, backup_legacy_into_app_data, detect_legacy_roots,
};

const SECRET_DECOY: &str = "sk-live-migrate-forbidden-key";
const SAFE_CONFIG: &str = r#"{"configVersion":1}"#;

fn write(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, body).unwrap();
}

fn write_bytes(path: &Path, body: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, body).unwrap();
}

fn write_ok_sqlite(path: &Path) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES ('local note');")
        .unwrap();
}

fn write_account_sqlite(path: &Path) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE accounts(email TEXT, password TEXT);
             INSERT INTO accounts VALUES ('user@example.com', 'not-migrated');",
        )
        .unwrap();
}

fn allow_cleanup(path: &Path) {
    if path.is_dir() {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                allow_cleanup(&entry.path());
            }
        }
    }
    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        let _ = fs::set_permissions(path, permissions);
    }
}

fn contains_secret_material(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "password",
        "secretvalue",
        "secretcontents",
        "\"token\"",
        "control_api_token",
        "desktop_session",
        SECRET_DECOY,
    ]
    .iter()
    .any(|needle| lower.contains(&needle.to_ascii_lowercase()))
}

#[test]
fn detects_repo_dev_tree_from_injected_repository() {
    let repo = tempfile::tempdir().unwrap();
    write(&repo.path().join("config/local.json"), SAFE_CONFIG);
    write_ok_sqlite(&repo.path().join("data/app.sqlite"));
    fs::create_dir_all(repo.path().join("data/materials")).unwrap();
    fs::create_dir_all(repo.path().join("data/avatar")).unwrap();

    let found = detect_legacy_roots(&[LegacySearchRoot::Repository(repo.path().to_path_buf())]);

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, LegacyKind::Repository);
    assert_eq!(found[0].path, repo.path());
    assert_eq!(
        found[0].config_path.as_deref(),
        Some(repo.path().join("config/local.json").as_path())
    );
    assert_eq!(
        found[0].sqlite_path.as_deref(),
        Some(repo.path().join("data/app.sqlite").as_path())
    );
    assert_eq!(
        found[0].materials_path.as_deref(),
        Some(repo.path().join("data/materials").as_path())
    );
}

#[test]
fn detects_electron_userdata_under_injected_appdata_only() {
    let app_data = tempfile::tempdir().unwrap();
    write(
        &app_data.path().join("AI Virtual Assistant/config.json"),
        SAFE_CONFIG,
    );
    write(
        &app_data
            .path()
            .join("authorized-interview-screen-helper/local.json"),
        SAFE_CONFIG,
    );
    write_ok_sqlite(
        &app_data
            .path()
            .join("authorized-interview-screen-helper/app.sqlite3"),
    );

    let found = detect_legacy_roots(&[LegacySearchRoot::AppData(app_data.path().to_path_buf())]);

    assert_eq!(found.len(), 2);
    assert!(
        found
            .iter()
            .all(|root| root.kind == LegacyKind::ElectronUserData)
    );
    assert!(
        found
            .iter()
            .all(|root| root.path.starts_with(app_data.path()))
    );
    assert!(found.iter().any(|root| {
        root.path.ends_with("AI Virtual Assistant")
            && root.config_path.as_ref().is_some_and(|path| {
                path.ends_with(Path::new("AI Virtual Assistant").join("config.json"))
            })
    }));
    assert!(found.iter().any(|root| {
        root.path.ends_with("authorized-interview-screen-helper")
            && root.sqlite_path.as_ref().is_some_and(|path| {
                path.ends_with(Path::new("authorized-interview-screen-helper").join("app.sqlite3"))
            })
    }));
}

#[test]
fn empty_injected_roots_yield_no_legacy_trees() {
    let empty = tempfile::tempdir().unwrap();
    let found = detect_legacy_roots(&[
        LegacySearchRoot::Repository(empty.path().to_path_buf()),
        LegacySearchRoot::AppData(empty.path().to_path_buf()),
    ]);
    assert!(found.is_empty());
}

#[test]
fn prefers_app_sqlite_over_sqlite3_in_repo_data() {
    let repo = tempfile::tempdir().unwrap();
    write(&repo.path().join("config/local.json"), SAFE_CONFIG);
    write_ok_sqlite(&repo.path().join("data/app.sqlite"));
    write_ok_sqlite(&repo.path().join("data/app.sqlite3"));

    let found = detect_legacy_roots(&[LegacySearchRoot::Repository(repo.path().to_path_buf())]);

    assert_eq!(
        found[0].sqlite_path.as_deref(),
        Some(repo.path().join("data/app.sqlite").as_path())
    );
}

#[test]
fn backup_writes_scrubbed_layout_and_hashes() {
    let repo = tempfile::tempdir().unwrap();
    write(&repo.path().join("config/local.json"), SAFE_CONFIG);
    write_ok_sqlite(&repo.path().join("data/app.sqlite"));
    write(
        &repo.path().join("data/materials/resume.md"),
        "工作经历\n2019.03-2021.06 负责订单服务。",
    );
    let root = detect_legacy_roots(&[LegacySearchRoot::Repository(repo.path().to_path_buf())])
        .into_iter()
        .next()
        .unwrap();
    let archive = tempfile::tempdir().unwrap();

    let report = backup_legacy(&root, archive.path()).unwrap();

    assert_eq!(report.archive_path, archive.path());
    assert!(archive.path().join("manifest.json").is_file());
    assert!(archive.path().join("config.json").is_file());
    assert!(archive.path().join("app.sqlite").is_file());
    assert!(archive.path().join("materials/resume.md").is_file());
    assert!(!archive.path().join("app.sqlite3").exists());
    assert!(report.files.contains(&"config.json".into()));
    assert!(report.files.contains(&"app.sqlite".into()));
    assert!(
        report
            .files
            .iter()
            .any(|name| name == "materials/resume.md")
    );
    assert!(report.omitted.is_empty());

    let config_json = fs::read_to_string(archive.path().join("config.json")).unwrap();
    let manifest_json = fs::read_to_string(archive.path().join("manifest.json")).unwrap();
    assert!(
        !contains_secret_material(&config_json),
        "config.json leaked secret material: {config_json}"
    );
    assert!(
        !contains_secret_material(&manifest_json),
        "manifest.json leaked secret material: {manifest_json}"
    );
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json).unwrap();
    assert!(manifest["hashes"]["config.json"].as_str().is_some());
    assert!(manifest["hashes"]["app.sqlite"].as_str().is_some());
    assert!(manifest["hashes"]["materials/resume.md"].as_str().is_some());
    assert_eq!(
        Connection::open_with_flags(
            archive.path().join("app.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap()
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .unwrap(),
        "ok"
    );
    allow_cleanup(archive.path());
}

#[test]
fn backup_omits_secret_bearing_config_and_forbidden_sidecar_files() {
    let electron = tempfile::tempdir().unwrap();
    write(
        &electron.path().join("config.json"),
        &serde_json::json!({
            "locale": "zh-CN",
            "control_api_token": "desktop-login-token",
            "desktop_session": "session-cookie",
            "cookies": "sid=abc",
            "apiKey": SECRET_DECOY
        })
        .to_string(),
    );
    write(&electron.path().join(".env"), "OPENAI_API_KEY=sk-env");
    write_bytes(
        &electron.path().join("id.pem"),
        b"-----BEGIN PRIVATE KEY-----\n",
    );
    write(&electron.path().join("Cookies"), "sid=abc");
    write_ok_sqlite(&electron.path().join("app.sqlite"));
    let root = crate::migrate::LegacyRoot {
        kind: LegacyKind::ElectronUserData,
        path: electron.path().to_path_buf(),
        config_path: Some(electron.path().join("config.json")),
        sqlite_path: Some(electron.path().join("app.sqlite")),
        materials_path: None,
    };
    let archive = tempfile::tempdir().unwrap();

    let report = backup_legacy(&root, archive.path()).unwrap();

    assert!(!archive.path().join("config.json").exists());
    assert!(!archive.path().join(".env").exists());
    assert!(!archive.path().join("id.pem").exists());
    assert!(!archive.path().join("Cookies").exists());
    assert!(archive.path().join("app.sqlite").is_file());
    assert!(archive.path().join("manifest.json").is_file());
    for name in ["config.json", ".env", "id.pem", "Cookies"] {
        assert!(
            report.omitted.iter().any(|item| item == name),
            "expected {name} in omitted: {:?}",
            report.omitted
        );
    }
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(archive.path().join("manifest.json")).unwrap())
            .unwrap();
    let omitted = manifest["omitted"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    assert!(omitted.contains(&"config.json".into()));
    assert!(!contains_secret_material(
        &fs::read_to_string(archive.path().join("manifest.json")).unwrap()
    ));
    allow_cleanup(archive.path());
}

#[test]
fn backup_skips_missing_sqlite_and_omits_corrupt_or_account_sqlite() {
    let missing = tempfile::tempdir().unwrap();
    write(&missing.path().join("config/local.json"), SAFE_CONFIG);
    let missing_root =
        detect_legacy_roots(&[LegacySearchRoot::Repository(missing.path().to_path_buf())])
            .into_iter()
            .next()
            .unwrap();
    let missing_archive = tempfile::tempdir().unwrap();
    let skipped = backup_legacy(&missing_root, missing_archive.path()).unwrap();
    assert!(!missing_archive.path().join("app.sqlite").exists());
    assert!(!skipped.files.iter().any(|name| name == "app.sqlite"));
    assert!(!skipped.omitted.iter().any(|name| name == "app.sqlite"));
    assert!(missing_archive.path().join("config.json").is_file());
    allow_cleanup(missing_archive.path());

    let corrupt = tempfile::tempdir().unwrap();
    write(&corrupt.path().join("config/local.json"), SAFE_CONFIG);
    write(
        &corrupt.path().join("data/app.sqlite"),
        "not-a-sqlite-database",
    );
    let corrupt_root =
        detect_legacy_roots(&[LegacySearchRoot::Repository(corrupt.path().to_path_buf())])
            .into_iter()
            .next()
            .unwrap();
    let corrupt_archive = tempfile::tempdir().unwrap();
    let omitted_corrupt = backup_legacy(&corrupt_root, corrupt_archive.path()).unwrap();
    assert!(!corrupt_archive.path().join("app.sqlite").exists());
    assert!(
        omitted_corrupt
            .omitted
            .iter()
            .any(|name| name == "app.sqlite")
    );
    allow_cleanup(corrupt_archive.path());

    let accounts = tempfile::tempdir().unwrap();
    write(&accounts.path().join("config/local.json"), SAFE_CONFIG);
    write_account_sqlite(&accounts.path().join("data/app.sqlite"));
    let accounts_root =
        detect_legacy_roots(&[LegacySearchRoot::Repository(accounts.path().to_path_buf())])
            .into_iter()
            .next()
            .unwrap();
    let accounts_archive = tempfile::tempdir().unwrap();
    let omitted_accounts = backup_legacy(&accounts_root, accounts_archive.path()).unwrap();
    assert!(!accounts_archive.path().join("app.sqlite").exists());
    assert!(
        omitted_accounts
            .omitted
            .iter()
            .any(|name| name == "app.sqlite")
    );
    allow_cleanup(accounts_archive.path());
}

#[test]
fn versioned_backup_is_readonly_under_backups_legacy_stamp() {
    let repo = tempfile::tempdir().unwrap();
    write(&repo.path().join("config/local.json"), SAFE_CONFIG);
    write_ok_sqlite(&repo.path().join("data/app.sqlite"));
    let root = detect_legacy_roots(&[LegacySearchRoot::Repository(repo.path().to_path_buf())])
        .into_iter()
        .next()
        .unwrap();
    let app_data = tempfile::tempdir().unwrap();
    let now = Utc.with_ymd_and_hms(2026, 9, 6, 2, 16, 0).unwrap();

    let report = backup_legacy_into_app_data(&root, app_data.path(), now).unwrap();

    assert_eq!(
        report.archive_path,
        app_data
            .path()
            .join("backups")
            .join("legacy-20260906T021600Z")
    );
    assert!(report.archive_path.join("manifest.json").is_file());
    assert!(
        fs::metadata(report.archive_path.join("manifest.json"))
            .unwrap()
            .permissions()
            .readonly()
    );
    assert!(
        fs::metadata(report.archive_path.join("config.json"))
            .unwrap()
            .permissions()
            .readonly()
    );
    allow_cleanup(app_data.path());
}
