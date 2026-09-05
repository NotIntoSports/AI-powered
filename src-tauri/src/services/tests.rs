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

struct OpenProbe;

impl ProviderProbe for OpenProbe {
    fn discover_models(
        &self,
        _: &ProviderEndpoint,
        _: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, ProviderError> {
        Ok(vec![DiscoveredModel {
            id: "model-a".into(),
        }])
    }
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
