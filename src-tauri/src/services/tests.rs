use std::sync::Arc;

use crate::{
    config::ConfigStore,
    providers::{DiscoveredModel, ProviderEndpoint, ProviderError, ProviderProbe},
    secrets::{MemorySecretStore, SecretService},
};

use super::{ProviderSaveInput, ProviderService};

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
