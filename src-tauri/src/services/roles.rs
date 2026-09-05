use serde::Deserialize;
use ts_rs::TS;

use crate::config::{ConfigError, ConfigStore, RoleProfileConfig};

const MAX_ID_BYTES: usize = 64;
const MAX_SYSTEM_PROMPT_BYTES: usize = 32 * 1024;
const MAX_OPENING_MESSAGE_BYTES: usize = 4 * 1024;
const MAX_STYLE_INSTRUCTIONS_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct RoleProfileSaveInput {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub opening_message: String,
    pub style_instructions: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct RoleProfileCopyInput {
    pub source_id: String,
    pub id: String,
}

#[derive(Debug)]
pub enum RoleProfileServiceError {
    InvalidId,
    FieldsInvalid,
    CopyIdInUse,
    NotFound,
    Config(ConfigError),
}

impl RoleProfileServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidId => "ROLE_PROFILE_ID_INVALID",
            Self::FieldsInvalid => "ROLE_PROFILE_FIELDS_INVALID",
            Self::CopyIdInUse => "ROLE_PROFILE_COPY_ID_IN_USE",
            Self::NotFound => "ROLE_PROFILE_NOT_FOUND",
            Self::Config(error) => error.code(),
        }
    }
}

pub struct RoleProfileService<'a> {
    config: &'a ConfigStore,
}

impl<'a> RoleProfileService<'a> {
    pub fn new(config: &'a ConfigStore) -> Self {
        Self { config }
    }

    pub fn save(
        &self,
        input: RoleProfileSaveInput,
    ) -> Result<RoleProfileConfig, RoleProfileServiceError> {
        let input = clean_save_input(input);
        validate_save_input(&input)?;
        let mut saved = None;
        self.config
            .update(|config| {
                let config_version = config
                    .role_profiles
                    .iter()
                    .find(|profile| profile.id == input.id)
                    .map(|profile| profile.config_version.saturating_add(1))
                    .unwrap_or(1);
                let profile = RoleProfileConfig {
                    id: input.id.clone(),
                    name: input.name.clone(),
                    system_prompt: input.system_prompt.clone(),
                    opening_message: input.opening_message.clone(),
                    style_instructions: input.style_instructions.clone(),
                    active: false,
                    config_version,
                };
                if let Some(existing) = config
                    .role_profiles
                    .iter_mut()
                    .find(|existing| existing.id == profile.id)
                {
                    *existing = profile.clone();
                } else {
                    config.role_profiles.push(profile.clone());
                }
                if config.active_role_profile_id.as_deref() == Some(&profile.id) {
                    config.active_role_profile_id = None;
                }
                saved = Some(profile);
                Ok(())
            })
            .map_err(RoleProfileServiceError::Config)?;
        saved.ok_or(RoleProfileServiceError::NotFound)
    }

    pub fn copy(
        &self,
        input: RoleProfileCopyInput,
    ) -> Result<RoleProfileConfig, RoleProfileServiceError> {
        let source_id = input.source_id.trim();
        let id = input.id.trim();
        validate_id(id)?;
        let mut copied = None;
        self.config
            .update(|config| {
                if config.role_profiles.iter().any(|profile| profile.id == id) {
                    return Err(ConfigError::new(
                        "ROLE_PROFILE_COPY_ID_IN_USE",
                        "Role profile copy ID is already in use",
                    ));
                }
                let source = config
                    .role_profiles
                    .iter()
                    .find(|profile| profile.id == source_id)
                    .ok_or_else(|| {
                        ConfigError::new("ROLE_PROFILE_NOT_FOUND", "Role profile not found")
                    })?;
                let profile = RoleProfileConfig {
                    id: id.into(),
                    name: source.name.clone(),
                    system_prompt: source.system_prompt.clone(),
                    opening_message: source.opening_message.clone(),
                    style_instructions: source.style_instructions.clone(),
                    active: false,
                    config_version: 1,
                };
                config.role_profiles.push(profile.clone());
                copied = Some(profile);
                Ok(())
            })
            .map_err(map_config_error)?;
        copied.ok_or(RoleProfileServiceError::NotFound)
    }

    pub fn activate(&self, id: &str) -> Result<RoleProfileConfig, RoleProfileServiceError> {
        let id = id.trim();
        let mut activated = None;
        self.config
            .update(|config| {
                if !config.role_profiles.iter().any(|profile| profile.id == id) {
                    return Err(ConfigError::new(
                        "ROLE_PROFILE_NOT_FOUND",
                        "Role profile not found",
                    ));
                }
                for profile in &mut config.role_profiles {
                    profile.active = profile.id == id;
                    if profile.active {
                        activated = Some(profile.clone());
                    }
                }
                config.active_role_profile_id = Some(id.into());
                Ok(())
            })
            .map_err(map_config_error)?;
        activated.ok_or(RoleProfileServiceError::NotFound)
    }

    pub fn delete(&self, id: &str) -> Result<(), RoleProfileServiceError> {
        let id = id.trim();
        self.config
            .update(|config| {
                let count = config.role_profiles.len();
                config.role_profiles.retain(|profile| profile.id != id);
                if config.role_profiles.len() == count {
                    return Err(ConfigError::new(
                        "ROLE_PROFILE_NOT_FOUND",
                        "Role profile not found",
                    ));
                }
                if config.active_role_profile_id.as_deref() == Some(id) {
                    config.active_role_profile_id = None;
                }
                Ok(())
            })
            .map(|_| ())
            .map_err(map_config_error)
    }
}

fn clean_save_input(input: RoleProfileSaveInput) -> RoleProfileSaveInput {
    RoleProfileSaveInput {
        id: input.id.trim().into(),
        name: input.name.trim().into(),
        system_prompt: input.system_prompt.trim().into(),
        opening_message: input.opening_message.trim().into(),
        style_instructions: input.style_instructions.trim().into(),
    }
}

fn validate_save_input(input: &RoleProfileSaveInput) -> Result<(), RoleProfileServiceError> {
    validate_id(&input.id)?;
    let fields_valid = !input.name.is_empty()
        && input.system_prompt.len() <= MAX_SYSTEM_PROMPT_BYTES
        && input.opening_message.len() <= MAX_OPENING_MESSAGE_BYTES
        && input.style_instructions.len() <= MAX_STYLE_INSTRUCTIONS_BYTES;
    if fields_valid {
        Ok(())
    } else {
        Err(RoleProfileServiceError::FieldsInvalid)
    }
}

fn validate_id(id: &str) -> Result<(), RoleProfileServiceError> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        });
    if valid {
        Ok(())
    } else {
        Err(RoleProfileServiceError::InvalidId)
    }
}

fn map_config_error(error: ConfigError) -> RoleProfileServiceError {
    match error.code() {
        "ROLE_PROFILE_COPY_ID_IN_USE" => RoleProfileServiceError::CopyIdInUse,
        "ROLE_PROFILE_NOT_FOUND" => RoleProfileServiceError::NotFound,
        _ => RoleProfileServiceError::Config(error),
    }
}
