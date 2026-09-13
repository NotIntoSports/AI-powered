use serde::{Deserialize, Serialize};
use ts_rs::TS;
use zeroize::Zeroizing;

use crate::{
    config::{
        ConfigError, ConfigStore, EmbeddingConfig, EmbeddingDistance, ModelConfig, SecretSlot,
    },
    providers::{EmbeddingError, EmbeddingProbe, ProviderEndpoint},
    secrets::{SecretError, SecretService},
};

const TEST_INPUT: &str = "AI Virtual Assistant embedding connectivity test";

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct EmbeddingConfigSaveInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    pub model_id: String,
    pub dimensions: u32,
    pub normalized: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct EmbeddingTestResult {
    pub id: String,
    pub ready: bool,
    pub dimensions: u32,
}

#[derive(Debug)]
pub enum EmbeddingServiceError {
    InvalidId,
    FieldsInvalid,
    SourceInvalid,
    NotFound,
    NotReady,
    Stale,
    Config(ConfigError),
    Secret(SecretError),
    Embedding(EmbeddingError),
    CredentialRollback,
    CredentialCleanup,
}

impl EmbeddingServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidId => "EMBEDDING_ID_INVALID",
            Self::FieldsInvalid => "EMBEDDING_FIELDS_INVALID",
            Self::SourceInvalid => "EMBEDDING_SOURCE_INVALID",
            Self::NotFound => "EMBEDDING_NOT_FOUND",
            Self::NotReady => "EMBEDDING_NOT_READY",
            Self::Stale => "EMBEDDING_STALE",
            Self::Config(error) => error.code(),
            Self::Secret(error) => error.code(),
            Self::Embedding(error) => error.code(),
            Self::CredentialRollback => "SECRET_ROLLBACK_FAILED",
            Self::CredentialCleanup => "SECRET_CLEANUP_FAILED",
        }
    }
}

pub fn embedding_endpoint(
    models: &ModelConfig,
    embedding: &EmbeddingConfig,
) -> Option<ProviderEndpoint> {
    let provider_id = embedding.provider_id.trim();
    if !provider_id.is_empty() {
        return models.providers.iter().find_map(|provider| {
            (provider.id == provider_id && !provider.base_url.trim().is_empty()).then(|| {
                ProviderEndpoint {
                    provider_id: provider.id.clone(),
                    base_url: provider.base_url.clone(),
                }
            })
        });
    }
    embedding
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(|url| ProviderEndpoint {
            provider_id: embedding.id.clone(),
            base_url: url.to_owned(),
        })
}

pub fn embedding_credential_slot<'a>(
    models: &'a ModelConfig,
    embedding: &'a EmbeddingConfig,
) -> Option<&'a SecretSlot> {
    let provider_id = embedding.provider_id.trim();
    if !provider_id.is_empty() {
        return models.providers.iter().find_map(|provider| {
            (provider.id == provider_id)
                .then(|| provider.credential.as_ref().filter(|slot| slot.configured))
                .flatten()
        });
    }
    embedding.credential.as_ref().filter(|slot| slot.configured)
}

pub fn embedding_space_provider_id(embedding: &EmbeddingConfig) -> String {
    let provider_id = embedding.provider_id.trim();
    if provider_id.is_empty() {
        format!("custom:{}", embedding.id)
    } else {
        provider_id.to_owned()
    }
}

pub struct EmbeddingService<'a> {
    config: &'a ConfigStore,
    secrets: &'a SecretService,
    probe: &'a dyn EmbeddingProbe,
}

impl<'a> EmbeddingService<'a> {
    pub fn new(
        config: &'a ConfigStore,
        secrets: &'a SecretService,
        probe: &'a dyn EmbeddingProbe,
    ) -> Self {
        Self {
            config,
            secrets,
            probe,
        }
    }

    pub fn save(
        &self,
        mut input: EmbeddingConfigSaveInput,
    ) -> Result<EmbeddingConfig, EmbeddingServiceError> {
        let id = super::ids::resolve_optional_id(input.id.as_deref())
            .map_err(|_| EmbeddingServiceError::InvalidId)?;
        let provider_id = input.provider_id.trim().to_owned();
        let base_url = input
            .base_url
            .take()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let model_id = input.model_id.trim().to_owned();
        if model_id.is_empty() || !(1..=65_536).contains(&input.dimensions) {
            return Err(EmbeddingServiceError::FieldsInvalid);
        }
        match (provider_id.is_empty(), base_url.is_some()) {
            (false, false) => validate_id(&provider_id)?,
            (true, true) => {}
            _ => return Err(EmbeddingServiceError::SourceInvalid),
        }

        let reference = credential_reference(&id);
        let old_secret = self
            .secrets
            .read(&reference)
            .map_err(EmbeddingServiceError::Secret)?;
        let submitted = input
            .api_key
            .take()
            .filter(|value| !value.trim().is_empty())
            .map(Zeroizing::new);
        let mut key_changed = false;
        if provider_id.is_empty()
            && let Some(value) = submitted.as_deref()
        {
            self.secrets
                .set(&reference, value)
                .map_err(EmbeddingServiceError::Secret)?;
            key_changed = true;
        }
        let custom_configured = provider_id.is_empty() && (key_changed || old_secret.is_some());

        let mut saved = None;
        let result = self.config.update(|config| {
            if !provider_id.is_empty()
                && !config
                    .models
                    .providers
                    .iter()
                    .any(|provider| provider.id == provider_id)
            {
                return Err(ConfigError::new(
                    "CONFIG_REFERENCE_MISSING",
                    "Embedding provider does not exist",
                ));
            }
            let config_version = config
                .knowledge
                .embedding_configs
                .iter()
                .find(|item| item.id == id)
                .map(|item| item.config_version.saturating_add(1))
                .unwrap_or(1);
            let embedding = EmbeddingConfig {
                id: id.clone(),
                provider_id: provider_id.clone(),
                base_url: base_url.clone(),
                credential: custom_configured.then(|| SecretSlot {
                    reference: reference.clone(),
                    configured: true,
                }),
                model_id: model_id.clone(),
                dimensions: input.dimensions,
                distance: EmbeddingDistance::Cosine,
                normalized: input.normalized,
                active: false,
                ready: false,
                status: Some("not_tested".into()),
                config_version,
            };
            if let Some(existing) = config
                .knowledge
                .embedding_configs
                .iter_mut()
                .find(|item| item.id == embedding.id)
            {
                *existing = embedding.clone();
            } else {
                config.knowledge.embedding_configs.push(embedding.clone());
            }
            if config.knowledge.active_embedding_config_id.as_deref() == Some(&embedding.id) {
                config.knowledge.active_embedding_config_id = None;
            }
            saved = Some(embedding);
            Ok(())
        });
        match result {
            Ok(_) => saved.ok_or(EmbeddingServiceError::NotFound),
            Err(error) => {
                if key_changed {
                    rollback_secret(
                        self.secrets,
                        &reference,
                        old_secret.as_deref().map(String::as_str),
                    )
                    .map_err(|_| EmbeddingServiceError::CredentialRollback)?;
                }
                Err(map_config_error(error))
            }
        }
    }

    pub fn test(&self, embedding_id: &str) -> Result<EmbeddingTestResult, EmbeddingServiceError> {
        let config = self.config.load().map_err(EmbeddingServiceError::Config)?;
        let embedding = config
            .knowledge
            .embedding_configs
            .iter()
            .find(|item| item.id == embedding_id)
            .cloned()
            .ok_or(EmbeddingServiceError::NotFound)?;
        let endpoint = embedding_endpoint(&config.models, &embedding)
            .ok_or(EmbeddingServiceError::SourceInvalid)?;
        let slot = embedding_credential_slot(&config.models, &embedding);
        let credential = slot
            .map(|slot| self.secrets.read(&slot.reference))
            .transpose()
            .map_err(EmbeddingServiceError::Secret)?
            .flatten();
        if slot.is_some() && credential.is_none() {
            mark_test_failed(self.config, embedding_id)?;
            return Err(EmbeddingServiceError::Secret(SecretError::Backend));
        }
        let vector = match self.probe.embed(
            &endpoint,
            credential.as_deref().map(String::as_str),
            &embedding.model_id,
            embedding.dimensions,
            TEST_INPUT,
        ) {
            Ok(vector) => vector,
            Err(error) => {
                mark_test_failed(self.config, embedding_id)?;
                return Err(EmbeddingServiceError::Embedding(error));
            }
        };
        if vector.len() as u32 != embedding.dimensions {
            mark_test_failed(self.config, embedding_id)?;
            return Err(EmbeddingServiceError::Embedding(
                EmbeddingError::DimensionMismatch,
            ));
        }
        self.config
            .update(|config| {
                let current = config
                    .knowledge
                    .embedding_configs
                    .iter_mut()
                    .find(|item| item.id == embedding_id)
                    .ok_or_else(|| {
                        ConfigError::new("EMBEDDING_NOT_FOUND", "Embedding configuration not found")
                    })?;
                if current.config_version != embedding.config_version {
                    return Err(ConfigError::new(
                        "EMBEDDING_STALE",
                        "Embedding configuration changed during test",
                    ));
                }
                current.ready = true;
                current.status = Some("ready".into());
                Ok(())
            })
            .map_err(map_config_error)?;
        Ok(EmbeddingTestResult {
            id: embedding_id.into(),
            ready: true,
            dimensions: embedding.dimensions,
        })
    }

    pub fn activate(&self, embedding_id: &str) -> Result<EmbeddingConfig, EmbeddingServiceError> {
        let mut activated = None;
        self.config
            .update(|config| {
                let target = config
                    .knowledge
                    .embedding_configs
                    .iter()
                    .find(|item| item.id == embedding_id)
                    .ok_or_else(|| {
                        ConfigError::new("EMBEDDING_NOT_FOUND", "Embedding configuration not found")
                    })?;
                if !target.ready
                    || target.status.as_deref() != Some("ready")
                    || target.config_version == 0
                {
                    return Err(ConfigError::new(
                        "EMBEDDING_NOT_READY",
                        "Embedding configuration must pass a test before activation",
                    ));
                }
                for item in &mut config.knowledge.embedding_configs {
                    item.active = item.id == embedding_id;
                    if item.active {
                        activated = Some(item.clone());
                    }
                }
                config.knowledge.active_embedding_config_id = Some(embedding_id.into());
                Ok(())
            })
            .map_err(map_config_error)?;
        activated.ok_or(EmbeddingServiceError::NotFound)
    }

    pub fn delete(&self, embedding_id: &str) -> Result<(), EmbeddingServiceError> {
        self.config
            .update(|config| {
                let original = config.knowledge.embedding_configs.len();
                config
                    .knowledge
                    .embedding_configs
                    .retain(|item| item.id != embedding_id);
                if original == config.knowledge.embedding_configs.len() {
                    return Err(ConfigError::new(
                        "EMBEDDING_NOT_FOUND",
                        "Embedding configuration not found",
                    ));
                }
                if config.knowledge.active_embedding_config_id.as_deref() == Some(embedding_id) {
                    config.knowledge.active_embedding_config_id = None;
                }
                Ok(())
            })
            .map_err(map_config_error)?;
        self.secrets
            .delete(&credential_reference(embedding_id))
            .map_err(|_| EmbeddingServiceError::CredentialCleanup)?;
        Ok(())
    }
}

fn credential_reference(embedding_id: &str) -> String {
    format!("embeddings/{embedding_id}/api-key")
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

fn validate_id(id: &str) -> Result<(), EmbeddingServiceError> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        });
    if valid {
        Ok(())
    } else {
        Err(EmbeddingServiceError::InvalidId)
    }
}

fn mark_test_failed(store: &ConfigStore, embedding_id: &str) -> Result<(), EmbeddingServiceError> {
    store
        .update(|config| {
            if let Some(current) = config
                .knowledge
                .embedding_configs
                .iter_mut()
                .find(|item| item.id == embedding_id)
            {
                current.ready = false;
                current.active = false;
                current.status = Some("test_failed".into());
            }
            if config.knowledge.active_embedding_config_id.as_deref() == Some(embedding_id) {
                config.knowledge.active_embedding_config_id = None;
            }
            Ok(())
        })
        .map_err(EmbeddingServiceError::Config)?;
    Ok(())
}

fn map_config_error(error: ConfigError) -> EmbeddingServiceError {
    match error.code() {
        "EMBEDDING_NOT_FOUND" => EmbeddingServiceError::NotFound,
        "EMBEDDING_NOT_READY" => EmbeddingServiceError::NotReady,
        "EMBEDDING_STALE" => EmbeddingServiceError::Stale,
        _ => EmbeddingServiceError::Config(error),
    }
}
