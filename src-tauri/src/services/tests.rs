use std::sync::Arc;

use crate::{
    config::{ConfigStore, EmbeddingDistance},
    providers::{
        DiscoveredModel, EmbeddingError, EmbeddingProbe, ProviderEndpoint, ProviderError,
        ProviderProbe,
    },
    secrets::{MemorySecretStore, SecretService},
};

use super::{
    EmbeddingConfigSaveInput, EmbeddingService, ProviderSaveInput, ProviderService,
    RoleProfileCopyInput, RoleProfileSaveInput, RoleProfileService,
};

fn role_input(id: &str) -> RoleProfileSaveInput {
    RoleProfileSaveInput {
        id: id.into(),
        name: " Interviewer ".into(),
        system_prompt: " Ask one question ".into(),
        opening_message: " Hello ".into(),
        style_instructions: " Concise ".into(),
    }
}

#[test]
fn role_save_creates_trimmed_profile_and_edit_resets_active_with_new_version() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::new(directory.path().join("config.json"));
    let service = RoleProfileService::new(&config);

    let saved = service.save(role_input("interviewer")).unwrap();
    assert_eq!(saved.id, "interviewer");
    assert_eq!(saved.name, "Interviewer");
    assert_eq!(saved.system_prompt, "Ask one question");
    assert_eq!(saved.opening_message, "Hello");
    assert_eq!(saved.style_instructions, "Concise");
    assert_eq!(saved.config_version, 1);
    assert!(!saved.active);

    assert!(service.activate("interviewer").unwrap().active);
    let edited = service
        .save(RoleProfileSaveInput {
            system_prompt: "Ask two questions".into(),
            ..role_input("interviewer")
        })
        .unwrap();
    assert_eq!(edited.config_version, 2);
    assert!(!edited.active);
    assert!(config.load().unwrap().active_role_profile_id.is_none());
}

#[test]
fn role_copy_clones_content_as_distinct_inactive_version_one_profile() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::new(directory.path().join("config.json"));
    let service = RoleProfileService::new(&config);
    let source = service.save(role_input("interviewer")).unwrap();
    service.activate("interviewer").unwrap();

    let copied = service
        .copy(RoleProfileCopyInput {
            source_id: "interviewer".into(),
            id: "panelist".into(),
        })
        .unwrap();

    assert_eq!(copied.id, "panelist");
    assert_eq!(copied.name, source.name);
    assert_eq!(copied.system_prompt, source.system_prompt);
    assert_eq!(copied.opening_message, source.opening_message);
    assert_eq!(copied.style_instructions, source.style_instructions);
    assert_eq!(copied.config_version, 1);
    assert!(!copied.active);
    assert_eq!(
        config.load().unwrap().active_role_profile_id.as_deref(),
        Some("interviewer")
    );
}

#[test]
fn role_copy_rejects_duplicate_destination_id() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::new(directory.path().join("config.json"));
    let service = RoleProfileService::new(&config);
    service.save(role_input("interviewer")).unwrap();

    assert_eq!(
        service
            .copy(RoleProfileCopyInput {
                source_id: "interviewer".into(),
                id: "interviewer".into(),
            })
            .unwrap_err()
            .code(),
        "ROLE_PROFILE_COPY_ID_IN_USE"
    );
}

#[test]
fn role_save_enforces_id_name_and_all_content_length_limits() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::new(directory.path().join("config.json"));
    let service = RoleProfileService::new(&config);

    let mut at_limits = role_input(&"a".repeat(64));
    at_limits.system_prompt = "p".repeat(32 * 1024);
    at_limits.opening_message = "o".repeat(4 * 1024);
    at_limits.style_instructions = "s".repeat(8 * 1024);
    assert!(service.save(at_limits).is_ok());

    for id in ["", "Uppercase", &"a".repeat(65)] {
        assert_eq!(
            service.save(role_input(id)).unwrap_err().code(),
            "ROLE_PROFILE_ID_INVALID"
        );
    }
    let mut empty_name = role_input("empty-name");
    empty_name.name = " \t ".into();
    assert_eq!(
        service.save(empty_name).unwrap_err().code(),
        "ROLE_PROFILE_FIELDS_INVALID"
    );
    for (id, field) in [
        ("prompt-too-long", "prompt"),
        ("opening-too-long", "opening"),
        ("style-too-long", "style"),
    ] {
        let mut input = role_input(id);
        match field {
            "prompt" => input.system_prompt = "p".repeat(32 * 1024 + 1),
            "opening" => input.opening_message = "o".repeat(4 * 1024 + 1),
            "style" => input.style_instructions = "s".repeat(8 * 1024 + 1),
            _ => unreachable!(),
        }
        assert_eq!(
            service.save(input).unwrap_err().code(),
            "ROLE_PROFILE_FIELDS_INVALID"
        );
    }
}

#[test]
fn role_activation_is_singleton_and_delete_clears_active_id_and_reports_missing_roles() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::new(directory.path().join("config.json"));
    let service = RoleProfileService::new(&config);
    service.save(role_input("interviewer")).unwrap();
    service.save(role_input("panelist")).unwrap();

    service.activate("interviewer").unwrap();
    assert!(service.activate("panelist").unwrap().active);
    let loaded = config.load().unwrap();
    assert_eq!(loaded.active_role_profile_id.as_deref(), Some("panelist"));
    assert_eq!(
        loaded
            .role_profiles
            .iter()
            .filter(|profile| profile.active)
            .map(|profile| profile.id.as_str())
            .collect::<Vec<_>>(),
        vec!["panelist"]
    );

    service.delete("panelist").unwrap();
    assert!(config.load().unwrap().active_role_profile_id.is_none());
    assert_eq!(
        service.activate("missing").unwrap_err().code(),
        "ROLE_PROFILE_NOT_FOUND"
    );
    assert_eq!(
        service.delete("missing").unwrap_err().code(),
        "ROLE_PROFILE_NOT_FOUND"
    );
}

#[test]
fn role_legacy_profile_requires_review_before_activation_until_saved() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(
        &path,
        r#"{"configVersion":1,"roleProfiles":[{"id":"legacy","instructions":"Ask one question"}]}"#,
    )
    .unwrap();
    let config = ConfigStore::new(path);
    let service = RoleProfileService::new(&config);

    let before = config.load().unwrap();
    let legacy = &before.role_profiles[0];
    assert_eq!(legacy.system_prompt, "Ask one question");
    assert_eq!(legacy.config_version, 0);
    assert!(!legacy.active);
    assert_eq!(
        service.activate("legacy").unwrap_err().code(),
        "ROLE_PROFILE_REVIEW_REQUIRED"
    );
    assert_eq!(config.load().unwrap(), before);

    let saved = service.save(role_input("legacy")).unwrap();
    assert_eq!(saved.config_version, 1);
    assert!(service.activate("legacy").unwrap().active);
}

#[test]
fn role_oversized_legacy_profile_stays_quarantined_without_activation_or_copy() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    let instructions = "legacy content ".repeat(3_000);
    assert!(instructions.len() > 32 * 1024);
    std::fs::write(
        &path,
        serde_json::json!({
            "configVersion": 1,
            "roleProfiles": [{
                "id": "legacy-oversized",
                "instructions": instructions,
            }],
        })
        .to_string(),
    )
    .unwrap();
    let config = ConfigStore::new(path);
    let service = RoleProfileService::new(&config);

    let before = config.load().unwrap();
    assert_eq!(before.role_profiles[0].config_version, 0);
    assert!(before.role_profiles[0].system_prompt.len() > 32 * 1024);
    assert_eq!(
        service.activate("legacy-oversized").unwrap_err().code(),
        "ROLE_PROFILE_REVIEW_REQUIRED"
    );
    assert_eq!(
        service
            .copy(RoleProfileCopyInput {
                source_id: "legacy-oversized".into(),
                id: "review-copy".into(),
            })
            .unwrap_err()
            .code(),
        "ROLE_PROFILE_REVIEW_REQUIRED"
    );
    assert_eq!(config.load().unwrap(), before);
}

struct FakeProbe;

impl ProviderProbe for FakeProbe {
    fn discover_models(
        &self,
        _: &ProviderEndpoint,
        credential: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, ProviderError> {
        assert_eq!(credential, Some("credential-value"));
        Ok(vec![DiscoveredModel {
            id: "model-a".into(),
        }])
    }
}

#[test]
fn provider_save_keeps_secret_out_of_config_and_discovers_models() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::new(directory.path().join("config.json"));
    config.restore_defaults().unwrap();
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let service = ProviderService::new(&config, &secrets, &FakeProbe);

    let saved = service
        .save(ProviderSaveInput {
            id: "openai".into(),
            name: Some("OpenAI compatible".into()),
            base_url: "https://example.test/v1".into(),
            api_key: Some("credential-value".into()),
        })
        .unwrap();
    assert_eq!(saved.id, "openai");
    assert!(saved.credential.unwrap().configured);
    assert!(
        !std::fs::read_to_string(directory.path().join("config.json"))
            .unwrap()
            .contains("credential-value")
    );

    let result = service.discover("openai").unwrap();
    assert_eq!(result.models[0].id, "model-a");
}

#[test]
fn provider_delete_rejects_referenced_provider() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(
        &path,
        r#"{"configVersion":1,"models":{"providers":[{"id":"p1","baseUrl":"https://example.test"}]},"speech":{"voiceRoutes":[{"id":"r1","name":"route","mode":"e2e","e2eProviderId":"p1","e2eModelId":"m1"}]}}"#,
    )
    .unwrap();
    let config = ConfigStore::new(path);
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let service = ProviderService::new(&config, &secrets, &FakeProbe);

    assert_eq!(service.delete("p1").unwrap_err().code(), "PROVIDER_IN_USE");
}

#[test]
fn provider_delete_rejects_provider_referenced_only_by_embedding_config() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(
        &path,
        r#"{
            "configVersion":1,
            "models":{"providers":[{"id":"p1","baseUrl":"https://example.test"}]},
            "knowledge":{"embeddingConfigs":[{
                "id":"embedding-1","providerId":"p1","modelId":"embed-1",
                "dimensions":1536,"distance":"cosine","normalized":true,
                "active":false,"ready":false,"status":null,"configVersion":1
            }]}
        }"#,
    )
    .unwrap();
    let config = ConfigStore::new(path);
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let service = ProviderService::new(&config, &secrets, &FakeProbe);

    assert_eq!(service.delete("p1").unwrap_err().code(), "PROVIDER_IN_USE");
}

struct OpenProbe;

impl ProviderProbe for OpenProbe {
    fn discover_models(
        &self,
        _: &ProviderEndpoint,
        _: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, ProviderError> {
        Ok(["model-a", "asr-1", "llm-1", "tts-1", "realtime"]
            .into_iter()
            .map(|id| DiscoveredModel { id: id.into() })
            .collect())
    }
}

struct FailProbe;

impl ProviderProbe for FailProbe {
    fn discover_models(
        &self,
        _: &ProviderEndpoint,
        _: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, ProviderError> {
        Err(ProviderError::Timeout)
    }
}

struct NoAuthProbe;

impl ProviderProbe for NoAuthProbe {
    fn discover_models(
        &self,
        _: &ProviderEndpoint,
        credential: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, ProviderError> {
        assert!(credential.is_none());
        Ok(vec![DiscoveredModel { id: "local".into() }])
    }
}

#[test]
fn provider_with_unconfigured_credential_slot_supports_no_auth_endpoint() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(&path, r#"{"configVersion":1,"models":{"providers":[{"id":"local","baseUrl":"http://127.0.0.1:11434/v1","credential":{"reference":"providers/local/api-key","configured":false}}]}}"#).unwrap();
    let config = ConfigStore::new(path);
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let service = ProviderService::new(&config, &secrets, &NoAuthProbe);

    assert_eq!(service.discover("local").unwrap().models[0].id, "local");
}

#[test]
fn voice_route_requires_test_before_single_activation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(
        &path,
        r#"{"configVersion":1,"models":{"providers":[{"id":"asr","baseUrl":"https://asr.test/v1"},{"id":"llm","baseUrl":"https://llm.test/v1"},{"id":"tts","baseUrl":"https://tts.test/v1"}]}}"#,
    )
    .unwrap();
    let config = ConfigStore::new(path);
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let service = super::VoiceRouteService::new(&config, &secrets, &OpenProbe);
    let route = service
        .save(super::VoiceRouteSaveInput {
            id: "default".into(),
            name: "Default".into(),
            mode: crate::config::VoiceRouteMode::Cascaded,
            asr_provider_id: Some("asr".into()),
            asr_model_id: Some("asr-1".into()),
            llm_provider_id: Some("llm".into()),
            llm_model_id: Some("llm-1".into()),
            tts_provider_id: Some("tts".into()),
            tts_model_id: Some("tts-1".into()),
            voice_id: None,
            e2e_provider_id: None,
            e2e_model_id: None,
        })
        .unwrap();
    assert!(!route.ready);
    assert_eq!(
        service.activate("default").unwrap_err().code(),
        "VOICE_ROUTE_NOT_READY"
    );

    let tested = service.test("default").unwrap();
    assert!(tested.ready);
    assert_eq!(tested.checked_provider_ids, vec!["asr", "llm", "tts"]);
    let active = service.activate("default").unwrap();
    assert!(active.active);
    assert_eq!(
        config
            .load()
            .unwrap()
            .speech
            .active_voice_route_id
            .as_deref(),
        Some("default")
    );
}

#[test]
fn e2e_route_rejects_cascaded_fields() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::new(directory.path().join("config.json"));
    config.restore_defaults().unwrap();
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let service = super::VoiceRouteService::new(&config, &secrets, &OpenProbe);
    let error = service
        .save(super::VoiceRouteSaveInput {
            id: "bad".into(),
            name: "Bad".into(),
            mode: crate::config::VoiceRouteMode::E2e,
            asr_provider_id: Some("asr".into()),
            asr_model_id: Some("asr-1".into()),
            llm_provider_id: None,
            llm_model_id: None,
            tts_provider_id: None,
            tts_model_id: None,
            voice_id: None,
            e2e_provider_id: Some("e2e".into()),
            e2e_model_id: Some("realtime".into()),
        })
        .unwrap_err();
    assert_eq!(error.code(), "VOICE_ROUTE_FIELDS_INVALID");
}

#[test]
fn failed_retest_deactivates_and_unreadies_route() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(&path, r#"{"configVersion":1,"models":{"providers":[{"id":"e2e","baseUrl":"https://e2e.test/v1"}]},"speech":{"voiceRoutes":[{"id":"route","name":"Route","mode":"e2e","e2eProviderId":"e2e","e2eModelId":"realtime","active":true,"ready":true,"status":"ready","configVersion":1}],"activeVoiceRouteId":"route"}}"#).unwrap();
    let config = ConfigStore::new(path);
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let service = super::VoiceRouteService::new(&config, &secrets, &FailProbe);
    assert_eq!(
        service.test("route").unwrap_err().code(),
        "PROVIDER_TIMEOUT"
    );
    let loaded = config.load().unwrap();
    assert!(loaded.speech.active_voice_route_id.is_none());
    assert!(!loaded.speech.voice_routes[0].active);
    assert!(!loaded.speech.voice_routes[0].ready);
}

#[test]
fn voice_route_test_rejects_a_model_missing_from_provider_catalog() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(
        &path,
        r#"{"configVersion":1,"models":{"providers":[{"id":"e2e","baseUrl":"https://e2e.test/v1"}]}}"#,
    )
    .unwrap();
    let config = ConfigStore::new(path);
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let service = super::VoiceRouteService::new(&config, &secrets, &OpenProbe);
    service
        .save(super::VoiceRouteSaveInput {
            id: "missing-model".into(),
            name: "Missing model".into(),
            mode: crate::config::VoiceRouteMode::E2e,
            asr_provider_id: None,
            asr_model_id: None,
            llm_provider_id: None,
            llm_model_id: None,
            tts_provider_id: None,
            tts_model_id: None,
            voice_id: None,
            e2e_provider_id: Some("e2e".into()),
            e2e_model_id: Some("does-not-exist".into()),
        })
        .unwrap();

    assert_eq!(
        service.test("missing-model").unwrap_err().code(),
        "VOICE_ROUTE_MODEL_NOT_FOUND"
    );
    let route = &config.load().unwrap().speech.voice_routes[0];
    assert!(!route.ready);
    assert_eq!(route.status.as_deref(), Some("test_failed"));
}

#[test]
fn incomplete_legacy_route_cannot_be_tested_or_activated() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(
        &path,
        r#"{"configVersion":1,"speech":{"voiceRoutes":[{"id":"legacy","name":"Legacy","mode":"cascaded"}]}}"#,
    )
    .unwrap();
    let config = ConfigStore::new(path);
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let service = super::VoiceRouteService::new(&config, &secrets, &OpenProbe);

    assert_eq!(
        service.test("legacy").unwrap_err().code(),
        "VOICE_ROUTE_FIELDS_INVALID"
    );
    assert_eq!(
        service.activate("legacy").unwrap_err().code(),
        "VOICE_ROUTE_NOT_READY"
    );
}

struct ReadyEmbeddingProbe;

impl EmbeddingProbe for ReadyEmbeddingProbe {
    fn embed(
        &self,
        _: &ProviderEndpoint,
        credential: Option<&str>,
        model_id: &str,
        dimensions: u32,
        input: &str,
    ) -> Result<Vec<f32>, EmbeddingError> {
        assert_eq!(credential, Some("credential-value"));
        assert_eq!(model_id, "embed-3");
        assert_eq!(input, "AI Virtual Assistant embedding connectivity test");
        Ok(vec![0.25; dimensions as usize])
    }
}

struct FailEmbeddingProbe;

impl EmbeddingProbe for FailEmbeddingProbe {
    fn embed(
        &self,
        _: &ProviderEndpoint,
        _: Option<&str>,
        _: &str,
        _: u32,
        _: &str,
    ) -> Result<Vec<f32>, EmbeddingError> {
        Err(EmbeddingError::Timeout)
    }
}

struct WrongDimensionProbe;

impl EmbeddingProbe for WrongDimensionProbe {
    fn embed(
        &self,
        _: &ProviderEndpoint,
        _: Option<&str>,
        _: &str,
        _: u32,
        _: &str,
    ) -> Result<Vec<f32>, EmbeddingError> {
        Ok(vec![1.0, 2.0])
    }
}

fn embedding_input(id: &str) -> EmbeddingConfigSaveInput {
    EmbeddingConfigSaveInput {
        id: id.into(),
        provider_id: "openai".into(),
        model_id: "embed-3".into(),
        dimensions: 3,
        normalized: true,
    }
}

fn seeded_embedding_store() -> (tempfile::TempDir, ConfigStore, SecretService) {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::new(directory.path().join("config.json"));
    config.restore_defaults().unwrap();
    let secrets = SecretService::new("test", Arc::new(MemorySecretStore::default())).unwrap();
    let providers = ProviderService::new(&config, &secrets, &FakeProbe);
    providers
        .save(ProviderSaveInput {
            id: "openai".into(),
            name: Some("OpenAI compatible".into()),
            base_url: "https://example.test/v1".into(),
            api_key: Some("credential-value".into()),
        })
        .unwrap();
    (directory, config, secrets)
}

#[test]
fn embedding_save_validates_provider_model_and_dimensions_and_resets_readiness() {
    let (_directory, config, secrets) = seeded_embedding_store();
    let service = EmbeddingService::new(&config, &secrets, &ReadyEmbeddingProbe);

    assert_eq!(
        service
            .save(EmbeddingConfigSaveInput {
                provider_id: "missing".into(),
                ..embedding_input("primary")
            })
            .unwrap_err()
            .code(),
        "CONFIG_REFERENCE_MISSING"
    );
    assert_eq!(
        service
            .save(EmbeddingConfigSaveInput {
                model_id: " ".into(),
                ..embedding_input("primary")
            })
            .unwrap_err()
            .code(),
        "EMBEDDING_FIELDS_INVALID"
    );
    assert_eq!(
        service
            .save(EmbeddingConfigSaveInput {
                dimensions: 0,
                ..embedding_input("primary")
            })
            .unwrap_err()
            .code(),
        "EMBEDDING_FIELDS_INVALID"
    );

    let saved = service.save(embedding_input("primary")).unwrap();
    assert_eq!(saved.config_version, 1);
    assert!(!saved.ready);
    assert!(!saved.active);
    assert_eq!(saved.status.as_deref(), Some("not_tested"));
    assert_eq!(saved.distance, EmbeddingDistance::Cosine);

    let tested = service.test("primary").unwrap();
    assert!(tested.ready);
    assert!(service.activate("primary").unwrap().active);

    let edited = service
        .save(EmbeddingConfigSaveInput {
            dimensions: 8,
            ..embedding_input("primary")
        })
        .unwrap();
    assert_eq!(edited.config_version, 2);
    assert!(!edited.ready);
    assert!(!edited.active);
    assert!(
        config
            .load()
            .unwrap()
            .knowledge
            .active_embedding_config_id
            .is_none()
    );
}

#[test]
fn embedding_test_reads_internal_credential_and_requires_exact_dimension() {
    let (_directory, config, secrets) = seeded_embedding_store();
    let service = EmbeddingService::new(&config, &secrets, &ReadyEmbeddingProbe);
    service.save(embedding_input("primary")).unwrap();

    let tested = service.test("primary").unwrap();
    assert!(tested.ready);
    assert_eq!(tested.dimensions, 3);

    let mismatch = EmbeddingService::new(&config, &secrets, &WrongDimensionProbe);
    assert_eq!(
        mismatch.test("primary").unwrap_err().code(),
        "EMBEDDING_DIMENSION_MISMATCH"
    );
    let loaded = config.load().unwrap();
    assert!(!loaded.knowledge.embedding_configs[0].ready);
    assert_eq!(
        loaded.knowledge.embedding_configs[0].status.as_deref(),
        Some("test_failed")
    );
}

#[test]
fn embedding_activation_requires_test_and_keeps_a_single_active_config() {
    let (_directory, config, secrets) = seeded_embedding_store();
    let service = EmbeddingService::new(&config, &secrets, &ReadyEmbeddingProbe);
    service.save(embedding_input("primary")).unwrap();
    service.save(embedding_input("secondary")).unwrap();

    assert_eq!(
        service.activate("primary").unwrap_err().code(),
        "EMBEDDING_NOT_READY"
    );
    service.test("primary").unwrap();
    service.test("secondary").unwrap();
    assert!(service.activate("primary").unwrap().active);
    assert!(service.activate("secondary").unwrap().active);

    let loaded = config.load().unwrap();
    assert_eq!(
        loaded.knowledge.active_embedding_config_id.as_deref(),
        Some("secondary")
    );
    assert!(!loaded.knowledge.embedding_configs[0].active);
    assert!(loaded.knowledge.embedding_configs[1].active);
}

struct VersionBumpProbe {
    path: std::path::PathBuf,
}

impl EmbeddingProbe for VersionBumpProbe {
    fn embed(
        &self,
        _: &ProviderEndpoint,
        _: Option<&str>,
        _: &str,
        _: u32,
        _: &str,
    ) -> Result<Vec<f32>, EmbeddingError> {
        let mut current: crate::config::AppConfigV1 =
            serde_json::from_str(&std::fs::read_to_string(&self.path).unwrap()).unwrap();
        current.knowledge.embedding_configs[0].config_version += 1;
        std::fs::write(&self.path, serde_json::to_string(&current).unwrap()).unwrap();
        Ok(vec![0.25, 0.25, 0.25])
    }
}

#[test]
fn failed_retest_deactivates_embedding_and_stale_test_is_rejected() {
    let (directory, config, secrets) = seeded_embedding_store();
    let service = EmbeddingService::new(&config, &secrets, &ReadyEmbeddingProbe);
    service.save(embedding_input("primary")).unwrap();
    service.test("primary").unwrap();
    service.activate("primary").unwrap();

    let failed = EmbeddingService::new(&config, &secrets, &FailEmbeddingProbe);
    assert_eq!(
        failed.test("primary").unwrap_err().code(),
        "EMBEDDING_TIMEOUT"
    );
    let loaded = config.load().unwrap();
    assert!(loaded.knowledge.active_embedding_config_id.is_none());
    assert!(!loaded.knowledge.embedding_configs[0].active);
    assert!(!loaded.knowledge.embedding_configs[0].ready);

    service.save(embedding_input("primary")).unwrap();
    let stale_probe = VersionBumpProbe {
        path: directory.path().join("config.json"),
    };
    let stale = EmbeddingService::new(&config, &secrets, &stale_probe);
    assert_eq!(stale.test("primary").unwrap_err().code(), "EMBEDDING_STALE");
    assert!(!config.load().unwrap().knowledge.embedding_configs[0].ready);
}

#[test]
fn embedding_delete_clears_active_id_and_provider_edit_invalidates_references() {
    let (_directory, config, secrets) = seeded_embedding_store();
    let service = EmbeddingService::new(&config, &secrets, &ReadyEmbeddingProbe);
    service.save(embedding_input("primary")).unwrap();
    service.test("primary").unwrap();
    service.activate("primary").unwrap();

    service.delete("primary").unwrap();
    let after_delete = config.load().unwrap();
    assert!(after_delete.knowledge.embedding_configs.is_empty());
    assert!(after_delete.knowledge.active_embedding_config_id.is_none());

    service.save(embedding_input("primary")).unwrap();
    service.test("primary").unwrap();
    service.activate("primary").unwrap();
    ProviderService::new(&config, &secrets, &FakeProbe)
        .save(ProviderSaveInput {
            id: "openai".into(),
            name: Some("Renamed".into()),
            base_url: "https://example.test/v2".into(),
            api_key: None,
        })
        .unwrap();
    let loaded = config.load().unwrap();
    assert!(!loaded.knowledge.embedding_configs[0].ready);
    assert!(!loaded.knowledge.embedding_configs[0].active);
    assert_eq!(
        loaded.knowledge.embedding_configs[0].status.as_deref(),
        Some("configuration_changed")
    );
    assert!(loaded.knowledge.active_embedding_config_id.is_none());
}
