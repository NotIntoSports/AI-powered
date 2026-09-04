use std::{collections::HashMap, ffi::OsString, path::PathBuf};

use super::ConfigError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDirs {
    pub repository: PathBuf,
    pub roaming_app_data: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigSource {
    CommandLine,
    Environment,
    DevelopmentDefault,
    ReleaseDefault,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigLocation {
    pub path: PathBuf,
    pub source: ConfigSource,
}

pub fn locate_config(
    args: &[OsString],
    env: &HashMap<String, OsString>,
    dirs: &ConfigDirs,
    development: bool,
) -> Result<ConfigLocation, ConfigError> {
    if let Some(index) = args.iter().position(|argument| argument == "--config") {
        let value = args
            .get(index + 1)
            .ok_or_else(|| ConfigError::new("CONFIG_FIELD_INVALID", "--config requires a path"))?;
        return explicit_location(PathBuf::from(value), ConfigSource::CommandLine);
    }
    if let Some(value) = env.get("AI_VIRTUAL_ASSISTANT_CONFIG") {
        return explicit_location(PathBuf::from(value), ConfigSource::Environment);
    }
    if development {
        Ok(ConfigLocation {
            path: dirs.repository.join("config").join("local.json"),
            source: ConfigSource::DevelopmentDefault,
        })
    } else {
        Ok(ConfigLocation {
            path: dirs
                .roaming_app_data
                .join("AI Virtual Assistant")
                .join("config.json"),
            source: ConfigSource::ReleaseDefault,
        })
    }
}

fn explicit_location(path: PathBuf, source: ConfigSource) -> Result<ConfigLocation, ConfigError> {
    if !path.is_absolute() {
        return Err(ConfigError::new(
            "CONFIG_PATH_NOT_ABSOLUTE",
            "Explicit configuration paths must be absolute",
        ));
    }
    Ok(ConfigLocation { path, source })
}
