use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    config::{ConfigError, ConfigStore, VoiceRouteConfig, VoiceRouteMode},
    providers::ProviderProbe,
    secrets::SecretService,
};

use super::{ProviderService, ProviderServiceError};

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct VoiceRouteSaveInput {
    pub id: String,
    pub name: String,
    pub mode: VoiceRouteMode,
    pub asr_provider_id: Option<String>,
    pub asr_model_id: Option<String>,
    pub llm_provider_id: Option<String>,
    pub llm_model_id: Option<String>,
    pub tts_provider_id: Option<String>,
    pub tts_model_id: Option<String>,
    pub voice_id: Option<String>,
    pub e2e_provider_id: Option<String>,
    pub e2e_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct VoiceRouteTestResult {
    pub route_id: String,
    pub ready: bool,
    pub checked_provider_ids: Vec<String>,
}

#[derive(Debug)]
pub enum VoiceRouteServiceError {
    InvalidId,
    FieldsInvalid,
    NotFound,
    NotReady,
    Config(ConfigError),
    Provider(ProviderServiceError),
}

impl VoiceRouteServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidId => "VOICE_ROUTE_ID_INVALID",
            Self::FieldsInvalid => "VOICE_ROUTE_FIELDS_INVALID",
            Self::NotFound => "VOICE_ROUTE_NOT_FOUND",
            Self::NotReady => "VOICE_ROUTE_NOT_READY",
            Self::Config(error) => error.code(),
            Self::Provider(error) => error.code(),
        }
    }
}

pub struct VoiceRouteService<'a> {
    config: &'a ConfigStore,
    secrets: &'a SecretService,
    probe: &'a dyn ProviderProbe,
}

impl<'a> VoiceRouteService<'a> {
    pub fn new(
        config: &'a ConfigStore,
        secrets: &'a SecretService,
        probe: &'a dyn ProviderProbe,
    ) -> Self {
        Self {
            config,
            secrets,
            probe,
        }
    }

    pub fn save(
        &self,
        input: VoiceRouteSaveInput,
    ) -> Result<VoiceRouteConfig, VoiceRouteServiceError> {
        validate_route_input(&input)?;
        let mut saved = None;
        self.config
            .update(|config| {
                let version = config
                    .speech
                    .voice_routes
                    .iter()
                    .find(|route| route.id == input.id)
                    .map(|route| route.config_version.saturating_add(1))
                    .unwrap_or(1);
                let route = VoiceRouteConfig {
                    id: input.id.clone(),
                    name: input.name.trim().to_owned(),
                    mode: input.mode,
                    asr_provider_id: clean(input.asr_provider_id.clone()),
                    asr_model_id: clean(input.asr_model_id.clone()),
                    llm_provider_id: clean(input.llm_provider_id.clone()),
                    llm_model_id: clean(input.llm_model_id.clone()),
                    tts_provider_id: clean(input.tts_provider_id.clone()),
                    tts_model_id: clean(input.tts_model_id.clone()),
                    voice_id: clean(input.voice_id.clone()),
                    e2e_provider_id: clean(input.e2e_provider_id.clone()),
                    e2e_model_id: clean(input.e2e_model_id.clone()),
                    active: false,
                    ready: false,
                    status: Some("not_tested".into()),
                    config_version: version,
                };
                if let Some(existing) = config
                    .speech
                    .voice_routes
                    .iter_mut()
                    .find(|item| item.id == route.id)
                {
                    *existing = route.clone();
                } else {
                    config.speech.voice_routes.push(route.clone());
                }
                if config.speech.active_voice_route_id.as_deref() == Some(&route.id) {
                    config.speech.active_voice_route_id = None;
                }
                saved = Some(route);
                Ok(())
            })
            .map_err(VoiceRouteServiceError::Config)?;
        saved.ok_or(VoiceRouteServiceError::NotFound)
    }

    pub fn test(&self, route_id: &str) -> Result<VoiceRouteTestResult, VoiceRouteServiceError> {
        let config = self.config.load().map_err(VoiceRouteServiceError::Config)?;
        let route = config
            .speech
            .voice_routes
            .iter()
            .find(|route| route.id == route_id)
            .cloned()
            .ok_or(VoiceRouteServiceError::NotFound)?;
        let providers = provider_ids(&route);
        let provider_service = ProviderService::new(self.config, self.secrets, self.probe);
        for provider_id in &providers {
            provider_service
                .test(provider_id)
                .map_err(VoiceRouteServiceError::Provider)?;
        }
        self.config
            .update(|config| {
                let current = config
                    .speech
                    .voice_routes
                    .iter_mut()
                    .find(|item| item.id == route_id)
                    .ok_or_else(|| {
                        ConfigError::new("VOICE_ROUTE_NOT_FOUND", "Voice route not found")
                    })?;
                if current.config_version != route.config_version {
                    return Err(ConfigError::new(
                        "VOICE_ROUTE_STALE",
                        "Voice route changed during test",
                    ));
                }
                current.ready = true;
                current.status = Some("ready".into());
                Ok(())
            })
            .map_err(VoiceRouteServiceError::Config)?;
        Ok(VoiceRouteTestResult {
            route_id: route_id.into(),
            ready: true,
            checked_provider_ids: providers,
        })
    }

    pub fn activate(&self, route_id: &str) -> Result<VoiceRouteConfig, VoiceRouteServiceError> {
        let mut activated = None;
        self.config
            .update(|config| {
                let target = config
                    .speech
                    .voice_routes
                    .iter()
                    .find(|route| route.id == route_id)
                    .ok_or_else(|| {
                        ConfigError::new("VOICE_ROUTE_NOT_FOUND", "Voice route not found")
                    })?;
                if !target.ready || target.status.as_deref() != Some("ready") {
                    return Err(ConfigError::new(
                        "VOICE_ROUTE_NOT_READY",
                        "Voice route must pass a test before activation",
                    ));
                }
                for route in &mut config.speech.voice_routes {
                    route.active = route.id == route_id;
                    if route.active {
                        activated = Some(route.clone());
                    }
                }
                config.speech.active_voice_route_id = Some(route_id.into());
                Ok(())
            })
            .map_err(|error| match error.code() {
                "VOICE_ROUTE_NOT_FOUND" => VoiceRouteServiceError::NotFound,
                "VOICE_ROUTE_NOT_READY" => VoiceRouteServiceError::NotReady,
                _ => VoiceRouteServiceError::Config(error),
            })?;
        activated.ok_or(VoiceRouteServiceError::NotFound)
    }

    pub fn delete(&self, route_id: &str) -> Result<(), VoiceRouteServiceError> {
        self.config
            .update(|config| {
                let original = config.speech.voice_routes.len();
                config
                    .speech
                    .voice_routes
                    .retain(|route| route.id != route_id);
                if original == config.speech.voice_routes.len() {
                    return Err(ConfigError::new(
                        "VOICE_ROUTE_NOT_FOUND",
                        "Voice route not found",
                    ));
                }
                if config.speech.active_voice_route_id.as_deref() == Some(route_id) {
                    config.speech.active_voice_route_id = None;
                }
                Ok(())
            })
            .map_err(|error| {
                if error.code() == "VOICE_ROUTE_NOT_FOUND" {
                    VoiceRouteServiceError::NotFound
                } else {
                    VoiceRouteServiceError::Config(error)
                }
            })?;
        Ok(())
    }
}

fn validate_route_input(input: &VoiceRouteSaveInput) -> Result<(), VoiceRouteServiceError> {
    let valid_id = !input.id.is_empty()
        && input.id.len() <= 64
        && input.id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        });
    if !valid_id {
        return Err(VoiceRouteServiceError::InvalidId);
    }
    if input.name.trim().is_empty() {
        return Err(VoiceRouteServiceError::FieldsInvalid);
    }
    let cascaded = [
        input.asr_provider_id.as_deref(),
        input.asr_model_id.as_deref(),
        input.llm_provider_id.as_deref(),
        input.llm_model_id.as_deref(),
        input.tts_provider_id.as_deref(),
        input.tts_model_id.as_deref(),
    ];
    let e2e = [
        input.e2e_provider_id.as_deref(),
        input.e2e_model_id.as_deref(),
    ];
    let valid = match input.mode {
        VoiceRouteMode::Cascaded => {
            cascaded.into_iter().all(present) && e2e.into_iter().all(|value| !present(value))
        }
        VoiceRouteMode::E2e => {
            e2e.into_iter().all(present) && cascaded.into_iter().all(|value| !present(value))
        }
    };
    if valid {
        Ok(())
    } else {
        Err(VoiceRouteServiceError::FieldsInvalid)
    }
}

fn present(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.trim().is_empty())
}

fn clean(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}

fn provider_ids(route: &VoiceRouteConfig) -> Vec<String> {
    [
        route.asr_provider_id.as_ref(),
        route.llm_provider_id.as_ref(),
        route.tts_provider_id.as_ref(),
        route.e2e_provider_id.as_ref(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .collect::<BTreeSet<_>>()
    .into_iter()
    .collect()
}
