mod locator;
mod store;

#[cfg(test)]
mod tests;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use ts_rs::TS;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct SecretSlot {
    pub reference: String,
    #[serde(default)]
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ApplicationConfig {
    #[serde(default)]
    pub locale: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub base_url: String,
    #[serde(default)]
    pub credential: Option<SecretSlot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ModelConfig {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default)]
    pub active_provider_id: Option<String>,
}

/// Voice pipeline mode. Cascaded runs ASR -> retrieval -> LLM -> TTS; E2e runs a
/// single Realtime round-trip. Exactly one route is active at a time (design §12.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, TS)]
pub enum VoiceRouteMode {
    #[default]
    #[serde(rename = "cascaded")]
    #[ts(rename = "cascaded")]
    Cascaded,
    #[serde(rename = "e2e")]
    #[ts(rename = "e2e")]
    E2e,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct VoiceRouteConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub mode: VoiceRouteMode,
    #[serde(default)]
    pub asr_provider_id: Option<String>,
    #[serde(default)]
    pub asr_model_id: Option<String>,
    #[serde(default)]
    pub llm_provider_id: Option<String>,
    #[serde(default)]
    pub llm_model_id: Option<String>,
    #[serde(default)]
    pub tts_provider_id: Option<String>,
    #[serde(default)]
    pub tts_model_id: Option<String>,
    #[serde(default)]
    pub voice_id: Option<String>,
    #[serde(default)]
    pub e2e_provider_id: Option<String>,
    #[serde(default)]
    pub e2e_model_id: Option<String>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub config_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct SpeechConfig {
    #[serde(default)]
    pub voice_routes: Vec<VoiceRouteConfig>,
    #[serde(default)]
    pub active_voice_route_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct TransportConfig {
    #[serde(default)]
    pub livekit_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct KnowledgeConfig {
    #[serde(default)]
    pub embedding_provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct StorageConfig {
    #[serde(default)]
    pub export_directory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct RoleProfile {
    pub id: String,
    pub instructions: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
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

/// Redacted, IPC-safe projection of the local configuration (design §7.3/§8.2).
///
/// Providers only ever carry a [`SecretSlot`] (`reference` + `configured`); the
/// secret *value* lives exclusively in the Windows Credential Manager and is
/// never present here, in JSON, SQLite, logs, or the frontend. This is the DTO
/// returned by the read-only `config_get_public` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PublicConfig {
    pub config_version: u32,
    pub application: ApplicationConfig,
    pub models: ModelConfig,
    pub speech: SpeechConfig,
    pub transport: TransportConfig,
    pub knowledge: KnowledgeConfig,
    pub storage: StorageConfig,
    pub role_profiles: Vec<RoleProfile>,
    pub diagnostics: DiagnosticsConfig,
}

/// Project the internal [`AppConfigV1`] onto its redacted public contract.
///
/// Read-only: clones the non-secret configuration sections. No secret value is
/// ever read or copied — credentials stay as [`SecretSlot`] references.
pub fn public_view(config: &AppConfigV1) -> PublicConfig {
    PublicConfig {
        config_version: config.config_version,
        application: config.application.clone(),
        models: config.models.clone(),
        speech: config.speech.clone(),
        transport: config.transport.clone(),
        knowledge: config.knowledge.clone(),
        storage: config.storage.clone(),
        role_profiles: config.role_profiles.clone(),
        diagnostics: config.diagnostics.clone(),
    }
}

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
            if let Some(credential) = &provider.credential
                && credential.reference != format!("providers/{}/api-key", provider.id)
            {
                return Err(ConfigError::new(
                    "CONFIG_SECRET_REFERENCE_INVALID",
                    "Provider credential reference is not canonical",
                ));
            }
        }
        if let Some(url) = &self.transport.livekit_url {
            validate_url(url, &["ws", "wss"])?;
        }
        if let Some(active) = &self.models.active_provider_id
            && !self
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
        if let Some(active) = &self.speech.active_voice_route_id
            && !self
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
        let active_routes = self
            .speech
            .voice_routes
            .iter()
            .filter(|route| route.active)
            .collect::<Vec<_>>();
        match self.speech.active_voice_route_id.as_deref() {
            Some(active_id)
                if active_routes.len() == 1
                    && active_routes[0].id == active_id
                    && active_routes[0].ready
                    && active_routes[0].status.as_deref() == Some("ready")
                    && active_routes[0].config_version > 0 => {}
            None if active_routes.is_empty() => {}
            _ => {
                return Err(ConfigError::new(
                    "CONFIG_ACTIVE_ROUTE_INVALID",
                    "Active voice route flags are inconsistent",
                ));
            }
        }
        for route in &self.speech.voice_routes {
            for provider_id in [
                route.asr_provider_id.as_ref(),
                route.llm_provider_id.as_ref(),
                route.tts_provider_id.as_ref(),
                route.e2e_provider_id.as_ref(),
            ] {
                if let Some(provider_id) = provider_id
                    && !self
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
        if let Some(provider_id) = &self.knowledge.embedding_provider_id
            && !self
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
        || url.query().is_some()
        || url.fragment().is_some()
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
