use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    config::{ConfigError, ConfigStore, EmbeddingConfig, EmbeddingDistance},
    providers::{EmbeddingError, EmbeddingProbe, ProviderEndpoint},
    secrets::{SecretError, SecretService},
};

const TEST_INPUT: &str = "AI Virtual Assistant embedding connectivity test";

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct EmbeddingConfigSaveInput {
    pub id: String,
    pub provider_id: String,
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
    NotFound,
    NotReady,
    Stale,
    Config(ConfigError),
    Secret(SecretError),
    Embedding(EmbeddingError),
}

impl EmbeddingServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidId => "EMBEDDING_ID_INVALID",
            Self::FieldsInvalid => "EMBEDDING_FIELDS_INVALID",
            Self::NotFound => "EMBEDDING_NOT_FOUND",
            Self::NotReady => "EMBEDDING_NOT_READY",
            Self::Stale => "EMBEDDING_STALE",
            Self::Config(error) => error.code(),
            Self::Secret(error) => error.code(),
            Self::Embedding(error) => error.code(),
        }
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
        input: EmbeddingConfigSaveInput,
    ) -> Result<EmbeddingConfig, EmbeddingServiceError> {
        let input = EmbeddingConfigSaveInput {
            id: input.id.trim().into(),
            provider_id: input.provider_id.trim().into(),
            model_id: input.model_id.trim().into(),
            dimensions: input.dimensions,
            normalized: input.normalized,
        };
        validate_id(&input.id)?;
        validate_id(&input.provider_id)?;
        if input.model_id.is_empty() || !(1..=65_536).contains(&input.dimensions) {
            return Err(EmbeddingServiceError::FieldsInvalid);
        }
        let mut saved = None;
        self.config
            .update(|config| {
                if !config
                    .models
                    .providers
                    .iter()
                    .any(|provider| provider.id == input.provider_id)
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
                    .find(|item| item.id == input.id)
                    .map(|item| item.config_version.saturating_add(1))
                    .unwrap_or(1);
                let embedding = EmbeddingConfig {
                    id: input.id.clone(),
                    provider_id: input.provider_id.clone(),
                    model_id: input.model_id.clone(),
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
            })
            .map_err(map_config_error)?;
        saved.ok_or(EmbeddingServiceError::NotFound)
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
        let provider = config
            .models
            .providers
            .iter()
            .find(|provider| provider.id == embedding.provider_id)
            .ok_or(EmbeddingServiceError::FieldsInvalid)?;
        let credential = provider
            .credential
            .as_ref()
            .filter(|slot| slot.configured)
            .map(|slot| self.secrets.read(&slot.reference))
            .transpose()
            .map_err(EmbeddingServiceError::Secret)?
            .flatten();
        if provider
            .credential
            .as_ref()
            .is_some_and(|slot| slot.configured)
            && credential.is_none()
        {
            mark_test_failed(self.config, embedding_id)?;
            return Err(EmbeddingServiceError::Secret(SecretError::Backend));
        }
        let vector = match self.probe.embed(
            &ProviderEndpoint {
                provider_id: provider.id.clone(),
                base_url: provider.base_url.clone(),
            },
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
        Ok(())
    }
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
