mod locator;
mod store;

#[cfg(test)]
mod tests;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub use locator::{ConfigDirs, ConfigLocation, ConfigSource, locate_config};
pub use store::{ConfigLoadOutcome, ConfigStore};

const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct ConfigError {
    code: &'static str,
    message: String,
}

impl ConfigError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretSlot {
    pub reference: String,
    #[serde(default)]
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationConfig {
    #[serde(default)]
    pub locale: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    pub id: String,
    pub base_url: String,
    #[serde(default)]
    pub credential: Option<SecretSlot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfig {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default)]
    pub active_provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceRouteConfig {
    pub id: String,
    #[serde(default)]
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechConfig {
    #[serde(default)]
    pub voice_routes: Vec<VoiceRouteConfig>,
    #[serde(default)]
    pub active_voice_route_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransportConfig {
    #[serde(default)]
    pub livekit_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeConfig {
    #[serde(default)]
    pub embedding_provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageConfig {
    #[serde(default)]
    pub export_directory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleProfile {
    pub id: String,
    pub instructions: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticsConfig {
    #[serde(default = "default_log_retention_days")]
    pub log_retention_days: u16,
}

fn default_log_retention_days() -> u16 {
    14
}

impl Default for DiagnosticsConfig {
    fn default() -> Self {
        Self {
            log_retention_days: default_log_retention_days(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfigV1 {
    pub config_version: u32,
    #[serde(default)]
    pub application: ApplicationConfig,
    #[serde(default)]
    pub models: ModelConfig,
    #[serde(default)]
    pub speech: SpeechConfig,
    #[serde(default)]
    pub transport: TransportConfig,
    #[serde(default)]
    pub knowledge: KnowledgeConfig,
    #[serde(default)]
    pub storage: StorageConfig,
    #[serde(default)]
    pub role_profiles: Vec<RoleProfile>,
    #[serde(default)]
    pub diagnostics: DiagnosticsConfig,
}

pub type PublicAppConfig = AppConfigV1;

impl Default for AppConfigV1 {
    fn default() -> Self {
        Self {
            config_version: CONFIG_VERSION,
            application: ApplicationConfig::default(),
            models: ModelConfig::default(),
            speech: SpeechConfig::default(),
            transport: TransportConfig::default(),
            knowledge: KnowledgeConfig::default(),
            storage: StorageConfig::default(),
            role_profiles: Vec::new(),
            diagnostics: DiagnosticsConfig::default(),
        }
    }
}

impl AppConfigV1 {
    pub fn from_json(json: &str) -> Result<Self, ConfigError> {
        let value: Value = serde_json::from_str(json)
            .map_err(|error| ConfigError::new("CONFIG_INVALID", error.to_string()))?;
        reject_inline_secrets(&value)?;
        match value.get("configVersion").and_then(Value::as_u64) {
            Some(version) if version == u64::from(CONFIG_VERSION) => {}
            Some(_) => {
                return Err(ConfigError::new(
                    "CONFIG_VERSION_UNSUPPORTED",
                    "Unsupported configVersion",
                ));
            }
            None => {
                return Err(ConfigError::new(
                    "CONFIG_INVALID",
                    "configVersion is required",
                ));
            }
        }
        let config: Self = serde_json::from_value(value)
            .map_err(|error| ConfigError::new("CONFIG_INVALID", error.to_string()))?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.config_version != CONFIG_VERSION {
            return Err(ConfigError::new(
                "CONFIG_VERSION_UNSUPPORTED",
                "Unsupported configVersion",
            ));
        }
        ensure_unique(self.models.providers.iter().map(|item| item.id.as_str()))?;
        ensure_unique(self.speech.voice_routes.iter().map(|item| item.id.as_str()))?;
        ensure_unique(self.role_profiles.iter().map(|item| item.id.as_str()))?;
        for provider in &self.models.providers {
            validate_url(&provider.base_url, &["http", "https"])?;
        }
        if let Some(url) = &self.transport.livekit_url {
            validate_url(url, &["ws", "wss"])?;
        }
        if let Some(active) = &self.models.active_provider_id {
            if !self
                .models
                .providers
                .iter()
                .any(|provider| &provider.id == active)
            {
                return Err(ConfigError::new(
                    "CONFIG_REFERENCE_MISSING",
                    "Active provider does not exist",
                ));
            }
        }
        if let Some(active) = &self.speech.active_voice_route_id {
            if !self
                .speech
                .voice_routes
                .iter()
                .any(|route| &route.id == active)
            {
                return Err(ConfigError::new(
                    "CONFIG_REFERENCE_MISSING",
                    "Active voice route does not exist",
                ));
            }
        }
        for route in &self.speech.voice_routes {
            if let Some(provider_id) = &route.provider_id {
                if !self
                    .models
                    .providers
                    .iter()
                    .any(|provider| &provider.id == provider_id)
                {
                    return Err(ConfigError::new(
                        "CONFIG_REFERENCE_MISSING",
                        "Voice route provider does not exist",
                    ));
                }
            }
        }
        if let Some(provider_id) = &self.knowledge.embedding_provider_id {
            if !self
                .models
                .providers
                .iter()
                .any(|provider| &provider.id == provider_id)
            {
                return Err(ConfigError::new(
                    "CONFIG_REFERENCE_MISSING",
                    "Embedding provider does not exist",
                ));
            }
        }
        if !(1..=365).contains(&self.diagnostics.log_retention_days) {
            return Err(ConfigError::new(
                "CONFIG_FIELD_INVALID",
                "logRetentionDays must be between 1 and 365",
            ));
        }
        Ok(())
    }
}

fn ensure_unique<'a>(ids: impl Iterator<Item = &'a str>) -> Result<(), ConfigError> {
    let mut seen = HashSet::new();
    for id in ids {
        if id.trim().is_empty() {
            return Err(ConfigError::new(
                "CONFIG_FIELD_INVALID",
                "IDs cannot be empty",
            ));
        }
        if !seen.insert(id) {
            return Err(ConfigError::new(
                "CONFIG_DUPLICATE_ID",
                "IDs must be unique",
            ));
        }
    }
    Ok(())
}

fn validate_url(raw: &str, schemes: &[&str]) -> Result<(), ConfigError> {
    let url = tauri::Url::parse(raw)
        .map_err(|_| ConfigError::new("CONFIG_URL_INVALID", "URL is invalid"))?;
    if !schemes.contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ConfigError::new(
            "CONFIG_URL_INVALID",
            "URL scheme or authority is invalid",
        ));
    }
    Ok(())
}

fn reject_inline_secrets(value: &Value) -> Result<(), ConfigError> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                let forbidden = normalized.contains("password")
                    || normalized.contains("apikey")
                    || normalized == "token"
                    || normalized.ends_with("token")
                    || (normalized.contains("secret") && normalized != "secretref");
                if forbidden {
                    return Err(ConfigError::new(
                        "CONFIG_SECRET_INLINE_FORBIDDEN",
                        "Inline secrets are forbidden",
                    ));
                }
                reject_inline_secrets(child)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_inline_secrets(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub struct ConfigPatch {
    pub diagnostics: Option<DiagnosticsPatch>,
}

#[derive(Debug, Clone, Default)]
pub struct DiagnosticsPatch {
    pub log_retention_days: Option<u16>,
}
