use serde::{Deserialize, Serialize};
use ts_rs::TS;
use zeroize::Zeroizing;

use crate::{
    config::{ConfigError, ConfigStore, ProviderConfig, SecretSlot},
    providers::{DiscoveredModel, ProviderEndpoint, ProviderError, ProviderProbe},
    secrets::{SecretError, SecretService},
};

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ProviderSaveInput {
    pub id: String,
    pub name: Option<String>,
    pub base_url: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub provider_id: String,
    pub reachable: bool,
    pub model_count: usize,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ModelDiscoveryResult {
    pub provider_id: String,
    pub models: Vec<DiscoveredModelDto>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct DiscoveredModelDto {
    pub id: String,
}

#[derive(Debug)]
pub enum ProviderServiceError {
    InvalidId,
    NotFound,
    InUse,
    Config(ConfigError),
    Secret(SecretError),
    Provider(ProviderError),
    CredentialRollback,
    CredentialCleanup,
}

impl ProviderServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidId => "PROVIDER_ID_INVALID",
            Self::NotFound => "PROVIDER_NOT_FOUND",
            Self::InUse => "PROVIDER_IN_USE",
            Self::Config(error) => error.code(),
            Self::Secret(error) => error.code(),
            Self::Provider(error) => error.code(),
            Self::CredentialRollback => "SECRET_ROLLBACK_FAILED",
            Self::CredentialCleanup => "SECRET_CLEANUP_FAILED",
        }
    }
}

pub struct ProviderService<'a> {
    config: &'a ConfigStore,
    secrets: &'a SecretService,
    probe: &'a dyn ProviderProbe,
}

impl<'a> ProviderService<'a> {
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
        mut input: ProviderSaveInput,
    ) -> Result<ProviderConfig, ProviderServiceError> {
        validate_provider_id(&input.id)?;
        let reference = credential_reference(&input.id);
        let old_secret = self
            .secrets
            .read(&reference)
            .map_err(ProviderServiceError::Secret)?;
        let submitted = input
            .api_key
            .take()
            .filter(|value| !value.trim().is_empty())
            .map(Zeroizing::new);
        if let Some(value) = submitted.as_deref() {
            self.secrets
                .set(&reference, value)
                .map_err(ProviderServiceError::Secret)?;
        }
        let configured = submitted.is_some() || old_secret.is_some();
        let provider = ProviderConfig {
            id: input.id.clone(),
            name: input.name.filter(|name| !name.trim().is_empty()),
            base_url: input.base_url,
            credential: configured.then(|| SecretSlot {
                reference: reference.clone(),
                configured: true,
            }),
        };
        let result = self.config.update(|config| {
            if let Some(existing) = config
                .models
                .providers
                .iter_mut()
                .find(|item| item.id == provider.id)
            {
                *existing = provider.clone();
            } else {
                config.models.providers.push(provider.clone());
            }
            for route in &mut config.speech.voice_routes {
                if route_uses_provider(route, &provider.id) {
                    route.ready = false;
                    route.active = false;
                    route.status = Some("configuration_changed".into());
                    route.config_version = route.config_version.saturating_add(1);
                    if config.speech.active_voice_route_id.as_deref() == Some(&route.id) {
                        config.speech.active_voice_route_id = None;
                    }
                }
            }
            Ok(())
        });
        match result {
            Ok(_) => Ok(provider),
            Err(error) => {
                if submitted.is_some() {
                    rollback_secret(
                        self.secrets,
                        &reference,
                        old_secret.as_deref().map(String::as_str),
                    )
                    .map_err(|_| ProviderServiceError::CredentialRollback)?;
                }
                Err(ProviderServiceError::Config(error))
            }
        }
    }

    pub fn discover(
        &self,
        provider_id: &str,
    ) -> Result<ModelDiscoveryResult, ProviderServiceError> {
        let config = self.config.load().map_err(ProviderServiceError::Config)?;
        let provider = config
            .models
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .ok_or(ProviderServiceError::NotFound)?;
        let credential = provider
            .credential
            .as_ref()
            .filter(|slot| slot.configured)
            .map(|slot| self.secrets.read(&slot.reference))
            .transpose()
            .map_err(ProviderServiceError::Secret)?
            .flatten();
        if provider
            .credential
            .as_ref()
            .is_some_and(|slot| slot.configured)
            && credential.is_none()
        {
            return Err(ProviderServiceError::Secret(SecretError::Backend));
        }
        let models = self
            .probe
            .discover_models(
                &ProviderEndpoint {
                    provider_id: provider.id.clone(),
                    base_url: provider.base_url.clone(),
                },
                credential.as_deref().map(String::as_str),
            )
            .map_err(ProviderServiceError::Provider)?;
        Ok(ModelDiscoveryResult {
            provider_id: provider_id.into(),
            models: models
                .into_iter()
                .map(|DiscoveredModel { id }| DiscoveredModelDto { id })
                .collect(),
        })
    }

    pub fn test(&self, provider_id: &str) -> Result<ProviderTestResult, ProviderServiceError> {
        let discovered = self.discover(provider_id)?;
        Ok(ProviderTestResult {
            provider_id: provider_id.into(),
            reachable: true,
            model_count: discovered.models.len(),
        })
    }

    pub fn activate(&self, provider_id: &str) -> Result<ProviderConfig, ProviderServiceError> {
        let mut activated = None;
        self.config
            .update(|config| {
                let provider = config
                    .models
                    .providers
                    .iter()
                    .find(|provider| provider.id == provider_id)
                    .cloned()
                    .ok_or_else(|| ConfigError::new("PROVIDER_NOT_FOUND", "Provider not found"))?;
                config.models.active_provider_id = Some(provider_id.into());
                activated = Some(provider);
                Ok(())
            })
            .map_err(ProviderServiceError::Config)?;
        activated.ok_or(ProviderServiceError::NotFound)
    }

    pub fn delete(&self, provider_id: &str) -> Result<(), ProviderServiceError> {
        validate_provider_id(provider_id)?;
        let reference = credential_reference(provider_id);
        let provider_exists = self
            .config
            .load()
            .map_err(ProviderServiceError::Config)?
            .models
            .providers
            .iter()
            .any(|provider| provider.id == provider_id);
        if provider_exists {
            self.config
                .update(|config| {
                    if config
                        .speech
                        .voice_routes
                        .iter()
                        .any(|route| route_uses_provider(route, provider_id))
                        || config
                            .knowledge
                            .embedding_configs
                            .iter()
                            .any(|embedding| embedding.provider_id == provider_id)
                    {
                        return Err(ConfigError::new("PROVIDER_IN_USE", "Provider is in use"));
                    }
                    let original = config.models.providers.len();
                    config
                        .models
                        .providers
                        .retain(|provider| provider.id != provider_id);
                    if original == config.models.providers.len() {
                        return Err(ConfigError::new("PROVIDER_NOT_FOUND", "Provider not found"));
                    }
                    if config.models.active_provider_id.as_deref() == Some(provider_id) {
                        config.models.active_provider_id = None;
                    }
                    Ok(())
                })
                .map_err(|error| match error.code() {
                    "PROVIDER_IN_USE" => ProviderServiceError::InUse,
                    "PROVIDER_NOT_FOUND" => ProviderServiceError::NotFound,
                    _ => ProviderServiceError::Config(error),
                })?;
        }
        self.secrets
            .delete(&reference)
            .map_err(|_| ProviderServiceError::CredentialCleanup)?;
        Ok(())
    }
}

fn rollback_secret(
    secrets: &SecretService,
    reference: &str,
    prior: Option<&str>,
) -> Result<(), SecretError> {
    if let Some(prior) = prior {
        secrets.set(reference, prior)?;
    } else {
        secrets.delete(reference)?;
    }
    Ok(())
}

fn validate_provider_id(id: &str) -> Result<(), ProviderServiceError> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        });
    if valid {
        Ok(())
    } else {
        Err(ProviderServiceError::InvalidId)
    }
}

fn credential_reference(provider_id: &str) -> String {
    format!("providers/{provider_id}/api-key")
}

fn route_uses_provider(route: &crate::config::VoiceRouteConfig, provider_id: &str) -> bool {
    [
        route.asr_provider_id.as_deref(),
        route.llm_provider_id.as_deref(),
        route.tts_provider_id.as_deref(),
        route.e2e_provider_id.as_deref(),
    ]
    .contains(&Some(provider_id))
}
