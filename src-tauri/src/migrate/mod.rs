use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags, backup::Backup};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    config::ConfigStore,
    materials::backup::{BackupError, file_sha256, reject_secret_bytes, write_scrubbed_config},
};

#[cfg(test)]
mod tests;

const ARCHIVE_MANIFEST: &str = "manifest.json";
const ARCHIVE_CONFIG: &str = "config.json";
const ARCHIVE_SQLITE: &str = "app.sqlite";
const ARCHIVE_MATERIALS: &str = "materials";
const ELECTRON_APP_NAMES: &[&str] = &["AI Virtual Assistant", "authorized-interview-screen-helper"];
const REMOTE_ACCOUNT_TABLES: &[&str] = &[
    "accounts",
    "users",
    "login_sessions",
    "auth_tokens",
    "remote_accounts",
];
const BACKUP_PAGES: i32 = 100;
const BACKUP_PAUSE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyKind {
    Repository,
    ElectronUserData,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacySearchRoot {
    Repository(PathBuf),
    AppData(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyRoot {
    pub kind: LegacyKind,
    pub path: PathBuf,
    pub config_path: Option<PathBuf>,
    pub sqlite_path: Option<PathBuf>,
    pub materials_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyBackupReport {
    pub archive_path: PathBuf,
    pub files: Vec<String>,
    pub omitted: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrateError {
    Operation,
}

impl MigrateError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Operation => "MIGRATE_OPERATION_FAILED",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyBackupManifest {
    schema_version: i64,
    kind: String,
    hashes: BTreeMap<String, String>,
    omitted: Vec<String>,
}

pub fn detect_legacy_roots(roots: &[LegacySearchRoot]) -> Vec<LegacyRoot> {
    let mut found = Vec::new();
    for root in roots {
        match root {
            LegacySearchRoot::Repository(repository) => {
                if let Some(detected) = detect_repository(repository) {
                    push_unique(&mut found, detected);
                }
            }
            LegacySearchRoot::AppData(app_data) => {
                for name in ELECTRON_APP_NAMES {
                    if let Some(detected) = detect_electron_user_data(&app_data.join(name)) {
                        push_unique(&mut found, detected);
                    }
                }
            }
        }
    }
    found
}

pub fn backup_legacy(root: &LegacyRoot, dest: &Path) -> Result<LegacyBackupReport, MigrateError> {
    fs::create_dir_all(dest).map_err(|_| MigrateError::Operation)?;
    let mut files = Vec::new();
    let mut omitted = scan_forbidden_sidecars(&root.path);
    let mut hashes = BTreeMap::new();

    if let Some(config_path) = &root.config_path {
        match copy_config(config_path, &dest.join(ARCHIVE_CONFIG))? {
            CopyOutcome::Copied => {
                files.push(ARCHIVE_CONFIG.to_owned());
                hashes.insert(
                    ARCHIVE_CONFIG.to_owned(),
                    hash_file(&dest.join(ARCHIVE_CONFIG))?,
                );
            }
            CopyOutcome::Omitted => omitted.push(ARCHIVE_CONFIG.to_owned()),
            CopyOutcome::Skipped => {}
        }
    }

    match root.sqlite_path.as_deref() {
        Some(sqlite_path) if sqlite_path.is_file() => {
            match copy_sqlite(sqlite_path, &dest.join(ARCHIVE_SQLITE))? {
                CopyOutcome::Copied => {
                    files.push(ARCHIVE_SQLITE.to_owned());
                    hashes.insert(
                        ARCHIVE_SQLITE.to_owned(),
                        hash_file(&dest.join(ARCHIVE_SQLITE))?,
                    );
                }
                CopyOutcome::Omitted => omitted.push(ARCHIVE_SQLITE.to_owned()),
                CopyOutcome::Skipped => {}
            }
        }
        _ => {}
    }

    if let Some(materials_path) = &root.materials_path
        && materials_path.is_dir()
    {
        copy_materials(
            materials_path,
            &dest.join(ARCHIVE_MATERIALS),
            &mut files,
            &mut omitted,
            &mut hashes,
        )?;
    }

    files.sort();
    files.dedup();
    omitted.sort();
    omitted.dedup();

    let manifest = LegacyBackupManifest {
        schema_version: 1,
        kind: "legacy".into(),
        hashes,
        omitted: omitted.clone(),
    };
    let manifest_bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|_| MigrateError::Operation)?;
    reject_secret_bytes(&manifest_bytes).map_err(|_| MigrateError::Operation)?;
    fs::write(dest.join(ARCHIVE_MANIFEST), manifest_bytes).map_err(|_| MigrateError::Operation)?;
    make_tree_readonly(dest)?;

    Ok(LegacyBackupReport {
        archive_path: dest.to_path_buf(),
        files,
        omitted,
    })
}

pub fn backup_legacy_into_app_data(
    root: &LegacyRoot,
    app_data: &Path,
    now: DateTime<Utc>,
) -> Result<LegacyBackupReport, MigrateError> {
    let dest = app_data
        .join("backups")
        .join(format!("legacy-{}", now.format("%Y%m%dT%H%M%SZ")));
    backup_legacy(root, &dest)
}

fn detect_repository(repository: &Path) -> Option<LegacyRoot> {
    let config_path = first_existing_file([repository.join("config").join("local.json")]);
    let sqlite_path = first_existing_file([
        repository.join("data").join("app.sqlite"),
        repository.join("data").join("app.sqlite3"),
    ]);
    let materials_path = existing_dir(repository.join("data").join(ARCHIVE_MATERIALS));
    let has_avatar = repository.join("data").join("avatar").is_dir()
        || repository.join("data").join("avatars").is_dir();
    if config_path.is_none() && sqlite_path.is_none() && materials_path.is_none() && !has_avatar {
        return None;
    }
    Some(LegacyRoot {
        kind: LegacyKind::Repository,
        path: repository.to_path_buf(),
        config_path,
        sqlite_path,
        materials_path,
    })
}

fn detect_electron_user_data(user_data: &Path) -> Option<LegacyRoot> {
    let config_path = first_existing_file([
        user_data.join("config.json"),
        user_data.join("local.json"),
        user_data.join("config").join("local.json"),
    ]);
    let sqlite_path = first_existing_file([
        user_data.join("app.sqlite"),
        user_data.join("app.sqlite3"),
        user_data.join("data").join("app.sqlite"),
        user_data.join("data").join("app.sqlite3"),
    ]);
    let materials_path = existing_dir(user_data.join(ARCHIVE_MATERIALS))
        .or_else(|| existing_dir(user_data.join("data").join(ARCHIVE_MATERIALS)));
    if config_path.is_none() && sqlite_path.is_none() {
        return None;
    }
    Some(LegacyRoot {
        kind: LegacyKind::ElectronUserData,
        path: user_data.to_path_buf(),
        config_path,
        sqlite_path,
        materials_path,
    })
}

fn push_unique(found: &mut Vec<LegacyRoot>, candidate: LegacyRoot) {
    if found.iter().any(|existing| existing.path == candidate.path) {
        return;
    }
    found.push(candidate);
}

fn first_existing_file(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

fn existing_dir(path: PathBuf) -> Option<PathBuf> {
    path.is_dir().then_some(path)
}

fn scan_forbidden_sidecars(root: &Path) -> Vec<String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut omitted = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_forbidden_sidecar(&name) {
            omitted.push(name);
        }
    }
    omitted
}

fn is_forbidden_sidecar(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower.ends_with(".pem")
        || lower == "cookies"
        || lower == "cookies-journal"
        || lower == "desktop_session"
        || lower == "control_api_token"
}

enum CopyOutcome {
    Copied,
    Omitted,
    Skipped,
}

fn copy_config(source: &Path, dest: &Path) -> Result<CopyOutcome, MigrateError> {
    if !source.is_file() {
        return Ok(CopyOutcome::Skipped);
    }
    let store = ConfigStore::new(source.to_path_buf());
    if store.load().is_ok() {
        return match write_scrubbed_config(&store, dest) {
            Ok(()) => Ok(CopyOutcome::Copied),
            Err(BackupError::SecretForbidden) => Ok(CopyOutcome::Omitted),
            Err(_) => Err(MigrateError::Operation),
        };
    }
    let bytes = fs::read(source).map_err(|_| MigrateError::Operation)?;
    if looks_like_secrets(&bytes) {
        return Ok(CopyOutcome::Omitted);
    }
    reject_secret_bytes(&bytes).map_err(|_| MigrateError::Operation)?;
    fs::write(dest, bytes).map_err(|_| MigrateError::Operation)?;
    Ok(CopyOutcome::Copied)
}

fn looks_like_secrets(bytes: &[u8]) -> bool {
    if reject_secret_bytes(bytes).is_err() {
        return true;
    }
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .is_some_and(json_has_secret_fields)
}

fn json_has_secret_fields(value: Value) -> bool {
    match value {
        Value::Object(map) => map
            .into_iter()
            .any(|(key, child)| secret_named_field(&key, &child) || json_has_secret_fields(child)),
        Value::Array(items) => items.into_iter().any(json_has_secret_fields),
        _ => false,
    }
}

fn secret_named_field(key: &str, value: &Value) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
    let canonical_secret_slot =
        matches!(normalized.as_str(), "apikey" | "apisecret") && is_secret_slot_value(value);
    if canonical_secret_slot {
        return false;
    }
    normalized.contains("password")
        || normalized == "cookies"
        || normalized == "controlapitoken"
        || normalized == "desktopsession"
        || normalized == "token"
        || normalized.ends_with("token")
        || normalized.contains("apikey")
        || (normalized.contains("secret") && normalized != "secretref")
}

fn is_secret_slot_value(value: &Value) -> bool {
    let Some(slot) = value.as_object() else {
        return false;
    };
    slot.len() == 2
        && slot.get("reference").is_some_and(Value::is_string)
        && slot.get("configured").is_some_and(Value::is_boolean)
}

fn copy_sqlite(source: &Path, dest: &Path) -> Result<CopyOutcome, MigrateError> {
    let source_conn = match Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(connection) => connection,
        Err(_) => return Ok(CopyOutcome::Omitted),
    };
    let check: String = match source_conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))
    {
        Ok(check) => check,
        Err(_) => return Ok(CopyOutcome::Omitted),
    };
    if check != "ok" || has_remote_account_tables(&source_conn) {
        return Ok(CopyOutcome::Omitted);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|_| MigrateError::Operation)?;
    }
    let mut dest_conn = Connection::open(dest).map_err(|_| MigrateError::Operation)?;
    {
        let backup =
            Backup::new(&source_conn, &mut dest_conn).map_err(|_| MigrateError::Operation)?;
        backup
            .run_to_completion(BACKUP_PAGES, BACKUP_PAUSE, None)
            .map_err(|_| MigrateError::Operation)?;
    }
    Ok(CopyOutcome::Copied)
}

fn has_remote_account_tables(connection: &Connection) -> bool {
    let Ok(mut statement) =
        connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    else {
        return false;
    };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return false;
    };
    rows.flatten().any(|name| {
        REMOTE_ACCOUNT_TABLES
            .iter()
            .any(|forbidden| name.eq_ignore_ascii_case(forbidden))
    })
}

fn copy_materials(
    source: &Path,
    dest: &Path,
    files: &mut Vec<String>,
    omitted: &mut Vec<String>,
    hashes: &mut BTreeMap<String, String>,
) -> Result<(), MigrateError> {
    fs::create_dir_all(dest).map_err(|_| MigrateError::Operation)?;
    copy_materials_dir(source, dest, source, files, omitted, hashes)
}

fn copy_materials_dir(
    root: &Path,
    dest_root: &Path,
    current: &Path,
    files: &mut Vec<String>,
    omitted: &mut Vec<String>,
    hashes: &mut BTreeMap<String, String>,
) -> Result<(), MigrateError> {
    for entry in fs::read_dir(current).map_err(|_| MigrateError::Operation)? {
        let entry = entry.map_err(|_| MigrateError::Operation)?;
        let file_type = entry.file_type().map_err(|_| MigrateError::Operation)?;
        let relative = relative_key(root, &entry.path())?;
        let archive_key = format!("{ARCHIVE_MATERIALS}/{relative}");
        let destination = dest_root.join(&relative);
        if file_type.is_dir() {
            fs::create_dir_all(&destination).map_err(|_| MigrateError::Operation)?;
            copy_materials_dir(root, dest_root, &entry.path(), files, omitted, hashes)?;
        } else if file_type.is_file() {
            let bytes = fs::read(entry.path()).map_err(|_| MigrateError::Operation)?;
            if reject_secret_bytes(&bytes).is_err() {
                omitted.push(archive_key);
                continue;
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|_| MigrateError::Operation)?;
            }
            fs::write(&destination, bytes).map_err(|_| MigrateError::Operation)?;
            hashes.insert(archive_key.clone(), hash_file(&destination)?);
            files.push(archive_key);
        }
    }
    Ok(())
}

fn relative_key(root: &Path, file: &Path) -> Result<String, MigrateError> {
    let relative = file
        .strip_prefix(root)
        .map_err(|_| MigrateError::Operation)?;
    Ok(relative
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn hash_file(path: &Path) -> Result<String, MigrateError> {
    file_sha256(path).map_err(|_| MigrateError::Operation)
}

fn make_tree_readonly(root: &Path) -> Result<(), MigrateError> {
    if root.is_file() {
        return make_readonly(root);
    }
    if !root.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|_| MigrateError::Operation)? {
        let entry = entry.map_err(|_| MigrateError::Operation)?;
        make_tree_readonly(&entry.path())?;
    }
    Ok(())
}

fn make_readonly(path: &Path) -> Result<(), MigrateError> {
    let mut permissions = fs::metadata(path)
        .map_err(|_| MigrateError::Operation)?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).map_err(|_| MigrateError::Operation)
}
