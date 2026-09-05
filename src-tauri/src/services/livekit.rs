use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use zeroize::Zeroizing;

use crate::{
    config::{ConfigError, ConfigStore, LiveKitConfig, SecretSlot},
    providers::{LiveKitError, LiveKitProbe, room_join_token},
    secrets::{SecretError, SecretService},
};

const JOIN_TOKEN_TTL_SECS: u32 = 60;

const API_KEY_REF: &str = "transport/livekit/api-key";
const API_SECRET_REF: &str = "transport/livekit/api-secret";

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct LiveKitSettingsSaveInput {
    pub url: Option<String>,
    pub api_key: Option<String>,
    pub api_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct LiveKitTestResult {
    pub ready: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct LiveKitJoinToken {
    pub url: String,
    pub token: String,
    pub room: String,
    pub identity: String,
    pub expires_in_sec: u32,
}

impl fmt::Debug for LiveKitJoinToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LiveKitJoinToken")
            .field("url", &self.url)
            .field("token", &"[redacted]")
            .field("room", &self.room)
            .field("identity", &self.identity)
            .field("expires_in_sec", &self.expires_in_sec)
            .finish()
    }
}

#[derive(Debug)]
pub enum LiveKitSettingsError {
    NotReady,
    Disabled,
    RoomInvalid,
    IdentityInvalid,
    Config(ConfigError),
    Secret(SecretError),
    Probe(LiveKitError),
    CredentialRollback,
}

impl LiveKitSettingsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotReady => "LIVEKIT_NOT_READY",
            Self::Disabled => "LIVEKIT_DISABLED",
            Self::RoomInvalid => "LIVEKIT_ROOM_INVALID",
            Self::IdentityInvalid => "LIVEKIT_IDENTITY_INVALID",
            Self::Config(error) => error.code(),
            Self::Secret(error) => error.code(),
            Self::Probe(error) => error.code(),
            Self::CredentialRollback => "SECRET_ROLLBACK_FAILED",
        }
    }
}

pub struct LiveKitSettingsService<'a> {
    config: &'a ConfigStore,
    secrets: &'a SecretService,
    probe: &'a dyn LiveKitProbe,
}

impl<'a> LiveKitSettingsService<'a> {
    pub fn new(
        config: &'a ConfigStore,
        secrets: &'a SecretService,
        probe: &'a dyn LiveKitProbe,
    ) -> Self {
        Self {
            config,
            secrets,
            probe,
        }
    }

    pub fn save(
        &self,
        mut input: LiveKitSettingsSaveInput,
    ) -> Result<LiveKitConfig, LiveKitSettingsError> {
        let submitted_key = take_secret(&mut input.api_key);
        let submitted_secret = take_secret(&mut input.api_secret);
        let old_key = self
            .secrets
            .read(API_KEY_REF)
            .map_err(LiveKitSettingsError::Secret)?;
        let old_secret = self
            .secrets
            .read(API_SECRET_REF)
            .map_err(LiveKitSettingsError::Secret)?;
        let mut key_changed = false;
        let mut secret_changed = false;
        if let Some(value) = submitted_key.as_deref() {
            self.secrets
                .set(API_KEY_REF, value)
                .map_err(LiveKitSettingsError::Secret)?;
            key_changed = true;
        }
        if let Some(value) = submitted_secret.as_deref() {
            if let Err(error) = self.secrets.set(API_SECRET_REF, value) {
                if key_changed {
                    rollback_secret(
                        self.secrets,
                        API_KEY_REF,
                        old_key.as_deref().map(String::as_str),
                    )
                    .map_err(|_| LiveKitSettingsError::CredentialRollback)?;
                }
                return Err(LiveKitSettingsError::Secret(error));
            }
            secret_changed = true;
        }
        let key_configured = key_changed || old_key.is_some();
        let secret_configured = secret_changed || old_secret.is_some();
        let url = input
            .url
            .map(|url| url.trim().to_owned())
            .filter(|url| !url.is_empty());
        let result = self.config.update(|config| {
            let version = config
                .transport
                .livekit
                .config_version
                .saturating_add(1)
                .max(1);
            config.transport.livekit = LiveKitConfig {
                enabled: false,
                url,
                api_key: key_configured.then(|| SecretSlot {
                    reference: API_KEY_REF.into(),
                    configured: true,
                }),
                api_secret: secret_configured.then(|| SecretSlot {
                    reference: API_SECRET_REF.into(),
                    configured: true,
                }),
                ready: false,
                status: Some("not_tested".into()),
                config_version: version,
            };
            Ok(())
        });
        match result {
            Ok(_) => self
                .config
                .load()
                .map(|config| config.transport.livekit)
                .map_err(LiveKitSettingsError::Config),
            Err(error) => {
                if secret_changed {
                    rollback_secret(
                        self.secrets,
                        API_SECRET_REF,
                        old_secret.as_deref().map(String::as_str),
                    )
                    .map_err(|_| LiveKitSettingsError::CredentialRollback)?;
                }
                if key_changed {
                    rollback_secret(
                        self.secrets,
                        API_KEY_REF,
                        old_key.as_deref().map(String::as_str),
                    )
                    .map_err(|_| LiveKitSettingsError::CredentialRollback)?;
                }
                Err(LiveKitSettingsError::Config(error))
            }
        }
    }

    pub fn test(&self) -> Result<LiveKitTestResult, LiveKitSettingsError> {
        let config = self.config.load().map_err(LiveKitSettingsError::Config)?;
        let livekit = config.transport.livekit.clone();
        let url = livekit
            .url
            .as_deref()
            .ok_or(LiveKitSettingsError::NotReady)?;
        let api_key = required_secret(self.secrets, &livekit.api_key)?;
        let api_secret = required_secret(self.secrets, &livekit.api_secret)?;
        if let Err(error) = self.probe.test(url, api_key.as_str(), api_secret.as_str()) {
            mark_test_failed(self.config)?;
            return Err(LiveKitSettingsError::Probe(error));
        }
        self.config
            .update(|config| {
                if config.transport.livekit.config_version != livekit.config_version {
                    return Err(ConfigError::new(
                        "LIVEKIT_STALE",
                        "LiveKit settings changed during test",
                    ));
                }
                config.transport.livekit.ready = true;
                config.transport.livekit.status = Some("ready".into());
                Ok(())
            })
            .map_err(LiveKitSettingsError::Config)?;
        Ok(LiveKitTestResult { ready: true })
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<LiveKitConfig, LiveKitSettingsError> {
        self.config
            .update(|config| {
                if enabled
                    && (!config.transport.livekit.ready
                        || config.transport.livekit.status.as_deref() != Some("ready")
                        || config.transport.livekit.url.is_none()
                        || !config
                            .transport
                            .livekit
                            .api_key
                            .as_ref()
                            .is_some_and(|slot| slot.configured)
                        || !config
                            .transport
                            .livekit
                            .api_secret
                            .as_ref()
                            .is_some_and(|slot| slot.configured)
                        || config.transport.livekit.config_version == 0)
                {
                    return Err(ConfigError::new(
                        "LIVEKIT_NOT_READY",
                        "LiveKit transport must pass a test before enable",
                    ));
                }
                config.transport.livekit.enabled = enabled;
                Ok(())
            })
            .map_err(|error| match error.code() {
                "LIVEKIT_NOT_READY" => LiveKitSettingsError::NotReady,
                _ => LiveKitSettingsError::Config(error),
            })?;
        self.config
            .load()
            .map(|config| config.transport.livekit)
            .map_err(LiveKitSettingsError::Config)
    }

    pub fn issue_join_token(
        &self,
        room: &str,
        identity: &str,
    ) -> Result<LiveKitJoinToken, LiveKitSettingsError> {
        let room = room.trim();
        let identity = identity.trim();
        if room.is_empty() {
            return Err(LiveKitSettingsError::RoomInvalid);
        }
        if identity.is_empty() {
            return Err(LiveKitSettingsError::IdentityInvalid);
        }
        let config = self.config.load().map_err(LiveKitSettingsError::Config)?;
        let livekit = &config.transport.livekit;
        if !livekit.ready || livekit.status.as_deref() != Some("ready") {
            return Err(LiveKitSettingsError::NotReady);
        }
        if !livekit.enabled {
            return Err(LiveKitSettingsError::Disabled);
        }
        let url = livekit
            .url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .ok_or(LiveKitSettingsError::NotReady)?
            .to_owned();
        let api_key = required_secret(self.secrets, &livekit.api_key)?;
        let api_secret = required_secret(self.secrets, &livekit.api_secret)?;
        let token = room_join_token(api_key.as_str(), api_secret.as_str(), room, identity)
            .map_err(LiveKitSettingsError::Probe)?;
        Ok(LiveKitJoinToken {
            url,
            token: token.as_str().to_owned(),
            room: room.to_owned(),
            identity: identity.to_owned(),
            expires_in_sec: JOIN_TOKEN_TTL_SECS,
        })
    }
}

fn take_secret(value: &mut Option<String>) -> Option<Zeroizing<String>> {
    value
        .take()
        .filter(|item| !item.trim().is_empty())
        .map(Zeroizing::new)
}

fn required_secret(
    secrets: &SecretService,
    slot: &Option<SecretSlot>,
) -> Result<Zeroizing<String>, LiveKitSettingsError> {
    let slot = slot
        .as_ref()
        .filter(|slot| slot.configured)
        .ok_or(LiveKitSettingsError::NotReady)?;
    secrets
        .read(&slot.reference)
        .map_err(LiveKitSettingsError::Secret)?
        .ok_or(LiveKitSettingsError::NotReady)
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

fn mark_test_failed(store: &ConfigStore) -> Result<(), LiveKitSettingsError> {
    store
        .update(|config| {
            config.transport.livekit.ready = false;
            config.transport.livekit.enabled = false;
            config.transport.livekit.status = Some("test_failed".into());
            Ok(())
        })
        .map_err(LiveKitSettingsError::Config)?;
    Ok(())
}
