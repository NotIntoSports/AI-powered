use std::{collections::HashMap, ffi::OsString, path::PathBuf};

use super::{
    AppConfigV1, ConfigDirs, ConfigError, ConfigPatch, ConfigSource, ConfigStore, DiagnosticsPatch,
    VoiceRouteMode, locate_config, public_view,
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

/// Case-insensitive scan for secret material keywords, mirroring the contract
/// regex `/apiKey|password|secret(Value|Contents)|token/i` without a regex dep.
fn contains_secret_material(json: &str) -> bool {
    let lower = json.to_ascii_lowercase();
    [
        "apikey",
        "password",
        "secretvalue",
        "secretcontents",
        "token",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
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
fn voice_route_defaults_are_backward_compatible() {
    let config =
        AppConfigV1::from_json(r#"{"configVersion":1,"speech":{"voiceRoutes":[{"id":"r"}]}}"#)
            .unwrap();
    let route = &config.speech.voice_routes[0];
    assert_eq!(route.mode, VoiceRouteMode::Cascaded);
    assert!(route.name.is_empty());
    assert!(!route.active);
    assert!(!route.ready);
    assert_eq!(route.config_version, 0);
    assert!(route.asr_provider_id.is_none());
    assert!(route.e2e_provider_id.is_none());
}

#[test]
fn voice_route_rejects_unknown_mode_and_missing_provider_reference() {
    assert_eq!(
        parse_error(r#"{"configVersion":1,"speech":{"voiceRoutes":[{"id":"r","mode":"turbo"}]}}"#)
            .code(),
        "CONFIG_INVALID"
    );
    assert_eq!(
        parse_error(r#"{"configVersion":1,"speech":{"voiceRoutes":[{"id":"r","mode":"cascaded","asrProviderId":"missing"}]}}"#).code(),
        "CONFIG_REFERENCE_MISSING"
    );
}

#[test]
fn public_view_exposes_secret_references_but_never_secret_material() {
    let config = AppConfigV1::from_json(
        r#"{
            "configVersion": 1,
            "models": {
                "providers": [{
                    "id": "p1",
                    "name": "Provider One",
                    "baseUrl": "https://one.example",
                    "credential": { "reference": "providers/p1/api-key", "configured": true }
                }],
                "activeProviderId": "p1"
            },
            "speech": {
                "voiceRoutes": [{
                    "id": "r1",
                    "name": "Route One",
                    "mode": "cascaded",
                    "asrProviderId": "p1",
                    "asrModelId": "asr-1",
                    "llmProviderId": "p1",
                    "llmModelId": "llm-1",
                    "ttsProviderId": "p1",
                    "ttsModelId": "tts-1",
                    "voiceId": "voice-1",
                    "active": true,
                    "ready": true,
                    "status": "ready",
                    "configVersion": 3
                }],
                "activeVoiceRouteId": "r1"
            }
        }"#,
    )
    .unwrap();

    let public = public_view(&config);
    let json = serde_json::to_string(&public).unwrap();

    // The credential survives only as a SecretSlot reference + configured flag.
    assert!(json.contains("providers/p1/api-key"));
    assert!(json.contains("\"configured\":true"));
    // Voice-route projection carries the full cascaded wiring.
    assert!(json.contains("\"asrModelId\":\"asr-1\""));
    assert!(json.contains("\"mode\":\"cascaded\""));
    // No secret material keyword may appear anywhere in the public projection.
    assert!(
        !contains_secret_material(&json),
        "public config leaked secret material: {json}"
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

#[test]
fn failed_last_good_write_does_not_commit_primary_config() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(&path, r#"{"configVersion":1}"#).unwrap();
    let store = ConfigStore::new(path.clone());
    std::fs::create_dir(store.last_good_path()).unwrap();

    assert!(
        store
            .save_patch(ConfigPatch {
                diagnostics: Some(DiagnosticsPatch {
                    log_retention_days: Some(30)
                }),
            })
            .is_err()
    );
    assert_eq!(store.load().unwrap().diagnostics.log_retention_days, 14);
}
