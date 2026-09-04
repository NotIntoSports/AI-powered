use std::{collections::HashMap, ffi::OsString, path::PathBuf};

use super::{
    AppConfigV1, ConfigDirs, ConfigError, ConfigPatch, ConfigSource, ConfigStore, DiagnosticsPatch,
    locate_config,
};

fn dirs() -> ConfigDirs {
    ConfigDirs {
        repository: PathBuf::from(r"E:\source\assistant"),
        roaming_app_data: PathBuf::from(r"C:\Users\tester\AppData\Roaming"),
    }
}

#[test]
fn config_path_precedence_is_deterministic() {
    let mut env = HashMap::new();
    env.insert(
        "AI_VIRTUAL_ASSISTANT_CONFIG".to_owned(),
        OsString::from(r"C:\env\config.json"),
    );
    env.insert("UNRELATED_SECRET".to_owned(), OsString::from("ignored"));

    let cli = locate_config(
        &[
            OsString::from("app"),
            OsString::from("--config"),
            OsString::from(r"D:\cli\config.json"),
        ],
        &env,
        &dirs(),
        true,
    )
    .unwrap();
    assert_eq!(cli.source, ConfigSource::CommandLine);
    assert_eq!(cli.path, PathBuf::from(r"D:\cli\config.json"));

    let from_env = locate_config(&[OsString::from("app")], &env, &dirs(), true).unwrap();
    assert_eq!(from_env.source, ConfigSource::Environment);
    assert_eq!(from_env.path, PathBuf::from(r"C:\env\config.json"));

    env.clear();
    let development = locate_config(&[], &env, &dirs(), true).unwrap();
    assert_eq!(development.source, ConfigSource::DevelopmentDefault);
    assert_eq!(
        development.path,
        PathBuf::from(r"E:\source\assistant\config\local.json")
    );

    let release = locate_config(&[], &env, &dirs(), false).unwrap();
    assert_eq!(release.source, ConfigSource::ReleaseDefault);
    assert_eq!(
        release.path,
        PathBuf::from(r"C:\Users\tester\AppData\Roaming\AI Virtual Assistant\config.json")
    );
}

#[test]
fn config_paths_from_cli_and_environment_must_be_absolute() {
    let error = locate_config(
        &[
            OsString::from("app"),
            OsString::from("--config"),
            OsString::from("relative.json"),
        ],
        &HashMap::new(),
        &dirs(),
        true,
    )
    .unwrap_err();
    assert_eq!(error.code(), "CONFIG_PATH_NOT_ABSOLUTE");

    let env = HashMap::from([(
        "AI_VIRTUAL_ASSISTANT_CONFIG".to_owned(),
        OsString::from("relative.json"),
    )]);
    assert_eq!(
        locate_config(&[], &env, &dirs(), false).unwrap_err().code(),
        "CONFIG_PATH_NOT_ABSOLUTE"
    );
}

fn parse_error(json: &str) -> ConfigError {
    AppConfigV1::from_json(json).unwrap_err()
}

#[test]
fn minimal_configuration_uses_safe_defaults() {
    let config = AppConfigV1::from_json(r#"{"configVersion":1}"#).unwrap();
    assert!(config.models.providers.is_empty());
    assert_eq!(config.diagnostics.log_retention_days, 14);
}

#[test]
fn tracked_example_is_valid_and_contains_no_configured_secret() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("config/local.example.json");
    let json = std::fs::read_to_string(path).unwrap();
    let config = AppConfigV1::from_json(&json).unwrap();

    assert!(config.models.providers.iter().all(|provider| {
        provider
            .credential
            .as_ref()
            .is_none_or(|slot| !slot.configured)
    }));
}

#[test]
fn rejects_unknown_versions_and_broken_references() {
    assert_eq!(
        parse_error(r#"{"configVersion":2}"#).code(),
        "CONFIG_VERSION_UNSUPPORTED"
    );
    assert_eq!(
        parse_error(r#"{"configVersion":1,"models":{"providers":[{"id":"same","baseUrl":"https://one.example"},{"id":"same","baseUrl":"https://two.example"}]}}"#).code(),
        "CONFIG_DUPLICATE_ID"
    );
    assert_eq!(
        parse_error(r#"{"configVersion":1,"models":{"activeProviderId":"missing"}}"#).code(),
        "CONFIG_REFERENCE_MISSING"
    );
    assert_eq!(
        parse_error(r#"{"configVersion":1,"knowledge":{"embeddingProviderId":"missing"}}"#).code(),
        "CONFIG_REFERENCE_MISSING"
    );
}

#[test]
fn rejects_unsafe_urls_inline_secrets_and_invalid_retention() {
    assert_eq!(
        parse_error(r#"{"configVersion":1,"models":{"providers":[{"id":"bad","baseUrl":"ftp://example.com"}]}}"#).code(),
        "CONFIG_URL_INVALID"
    );
    assert_eq!(
        parse_error(r#"{"configVersion":1,"models":{"providers":[{"id":"bad","baseUrl":"https://example.com","apiKey":"do-not-store"}]}}"#).code(),
        "CONFIG_SECRET_INLINE_FORBIDDEN"
    );
    assert_eq!(
        parse_error(r#"{"configVersion":1,"diagnostics":{"logRetentionDays":0}}"#).code(),
        "CONFIG_FIELD_INVALID"
    );
}

#[test]
fn store_saves_atomically_and_keeps_a_last_good_copy() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(&path, r#"{"configVersion":1}"#).unwrap();
    let store = ConfigStore::new(path.clone());

    let saved = store
        .save_patch(ConfigPatch {
            diagnostics: Some(DiagnosticsPatch {
                log_retention_days: Some(30),
            }),
        })
        .unwrap();
    assert_eq!(saved.diagnostics.log_retention_days, 30);
    assert_eq!(store.load().unwrap(), saved);
    assert_eq!(
        AppConfigV1::from_json(&std::fs::read_to_string(store.last_good_path()).unwrap()).unwrap(),
        saved
    );

    let before = std::fs::read_to_string(&path).unwrap();
    let error = store
        .save_patch(ConfigPatch {
            diagnostics: Some(DiagnosticsPatch {
                log_retention_days: Some(0),
            }),
        })
        .unwrap_err();
    assert_eq!(error.code(), "CONFIG_FIELD_INVALID");
    assert_eq!(std::fs::read_to_string(path).unwrap(), before);
}
