//! Resolve owned OBS, AudioBridge, and prerequisite paths. Does not download, copy, or spawn.

use std::path::{Component, Path, PathBuf};

pub const OBS_PACKAGED_VERSION: &str = "32.2.1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathRoots {
    pub repository: PathBuf,
    pub resource_root: PathBuf,
    pub data_directory: PathBuf,
    pub development: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPaths {
    pub obs_template: PathBuf,
    pub obs_runtime: PathBuf,
    pub audio_bridge: PathBuf,
    pub vb_cable_pack: PathBuf,
    pub vb_cable_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PathError {
    #[error("OBS portable template is missing")]
    TemplateMissing,
    #[error("Resolved path escaped the allowed root")]
    EscapedRoot,
}

impl PathError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::TemplateMissing => "OBS_TEMPLATE_MISSING",
            Self::EscapedRoot => "OWNED_PATH_ESCAPED",
        }
    }
}

pub fn owned_path(root: &Path, relative: &Path) -> Result<PathBuf, PathError> {
    if !root.is_absolute() || relative.is_absolute() {
        return Err(PathError::EscapedRoot);
    }
    for component in relative.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(PathError::EscapedRoot);
            }
        }
    }
    let root = normalize_lexically(root);
    let joined = normalize_lexically(&root.join(relative));
    if !is_under(&joined, &root) {
        return Err(PathError::EscapedRoot);
    }
    Ok(joined)
}

pub fn resolve_owned_paths(roots: &PathRoots) -> Result<ResolvedPaths, PathError> {
    if !roots.repository.is_absolute()
        || !roots.resource_root.is_absolute()
        || !roots.data_directory.is_absolute()
    {
        return Err(PathError::EscapedRoot);
    }

    let obs_template = owned_path(
        &roots.resource_root,
        Path::new("prerequisites/obs-portable"),
    )?;
    let obs_runtime = owned_path(
        &roots.data_directory,
        &Path::new("runtime/obs").join(OBS_PACKAGED_VERSION),
    )?;
    let audio_bridge = if roots.development {
        owned_path(
            &roots.repository,
            Path::new("native/AudioBridge/publish/AudioBridge.exe"),
        )?
    } else {
        owned_path(
            &roots.resource_root,
            Path::new("audio-bridge/AudioBridge.exe"),
        )?
    };
    let vb_cable_pack = owned_path(&roots.resource_root, Path::new("prerequisites"))?;
    let vb_cable_dir = owned_path(&vb_cable_pack, Path::new("vb-cable"))?;

    if !obs_template.is_dir() {
        return Err(PathError::TemplateMissing);
    }

    Ok(ResolvedPaths {
        obs_template,
        obs_runtime,
        audio_bridge,
        vb_cable_pack,
        vb_cable_present: vb_cable_dir.is_dir(),
    })
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_under(path: &Path, root: &Path) -> bool {
    let path_components: Vec<_> = path.components().collect();
    let root_components: Vec<_> = root.components().collect();
    if root_components.len() > path_components.len() {
        return false;
    }
    path_components
        .iter()
        .zip(root_components.iter())
        .all(|(left, right)| {
            if cfg!(windows) {
                left.as_os_str().eq_ignore_ascii_case(right.as_os_str())
            } else {
                left == right
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn roots(directory: &tempfile::TempDir, development: bool) -> PathRoots {
        let repository = directory.path().to_path_buf();
        PathRoots {
            resource_root: repository.join("resources"),
            data_directory: repository.join("data"),
            repository,
            development,
        }
    }

    fn write_template(roots: &PathRoots) {
        fs::create_dir_all(
            roots
                .resource_root
                .join("prerequisites")
                .join("obs-portable"),
        )
        .unwrap();
        fs::create_dir_all(&roots.data_directory).unwrap();
    }

    #[test]
    fn missing_obs_template_is_typed_error() {
        let directory = tempfile::tempdir().unwrap();
        let roots = roots(&directory, true);
        fs::create_dir_all(roots.resource_root.join("prerequisites")).unwrap();
        fs::create_dir_all(&roots.data_directory).unwrap();
        let error = resolve_owned_paths(&roots).expect_err("missing template");
        assert_eq!(error, PathError::TemplateMissing);
        assert_eq!(error.code(), "OBS_TEMPLATE_MISSING");
    }

    #[test]
    fn runtime_path_stays_under_data_directory() {
        let directory = tempfile::tempdir().unwrap();
        let roots = roots(&directory, true);
        write_template(&roots);
        let resolved = resolve_owned_paths(&roots).expect("template present");
        assert_eq!(
            resolved.obs_runtime,
            roots
                .data_directory
                .join("runtime")
                .join("obs")
                .join(OBS_PACKAGED_VERSION)
        );
        assert!(resolved.obs_runtime.starts_with(&roots.data_directory));
        assert_eq!(
            resolved.obs_template,
            roots
                .resource_root
                .join("prerequisites")
                .join("obs-portable")
        );
    }

    #[test]
    fn development_audiobridge_is_publish_exe() {
        let directory = tempfile::tempdir().unwrap();
        let roots = roots(&directory, true);
        write_template(&roots);
        let resolved = resolve_owned_paths(&roots).expect("template present");
        assert_eq!(
            resolved.audio_bridge,
            roots
                .repository
                .join("native")
                .join("AudioBridge")
                .join("publish")
                .join("AudioBridge.exe")
        );
        assert!(resolved.audio_bridge.starts_with(&roots.repository));
    }

    #[test]
    fn release_audiobridge_is_bundled_sidecar() {
        let directory = tempfile::tempdir().unwrap();
        let roots = roots(&directory, false);
        write_template(&roots);
        let resolved = resolve_owned_paths(&roots).expect("template present");
        assert_eq!(
            resolved.audio_bridge,
            roots
                .resource_root
                .join("audio-bridge")
                .join("AudioBridge.exe")
        );
        assert!(resolved.audio_bridge.starts_with(&roots.resource_root));
    }

    #[test]
    fn rejects_path_that_escapes_allowed_root() {
        let directory = tempfile::tempdir().unwrap();
        let error = owned_path(
            directory.path(),
            Path::new("runtime/obs/32.2.1/../../../outside"),
        )
        .expect_err("escape");
        assert_eq!(error, PathError::EscapedRoot);
        assert_eq!(error.code(), "OWNED_PATH_ESCAPED");
    }

    #[test]
    fn rejects_absolute_candidate_and_relative_root() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            owned_path(directory.path(), directory.path())
                .expect_err("absolute candidate")
                .code(),
            "OWNED_PATH_ESCAPED"
        );
        assert_eq!(
            owned_path(Path::new("relative-root"), Path::new("obs"))
                .expect_err("relative root")
                .code(),
            "OWNED_PATH_ESCAPED"
        );
    }

    #[test]
    fn owned_path_stays_under_root() {
        let directory = tempfile::tempdir().unwrap();
        let resolved =
            owned_path(directory.path(), Path::new("runtime/obs/32.2.1")).expect("safe join");
        assert_eq!(
            resolved,
            directory
                .path()
                .join("runtime")
                .join("obs")
                .join(OBS_PACKAGED_VERSION)
        );
    }

    #[test]
    fn vb_cable_pack_is_optional() {
        let directory = tempfile::tempdir().unwrap();
        let roots = roots(&directory, true);
        write_template(&roots);
        let resolved = resolve_owned_paths(&roots).expect("template present");
        assert_eq!(
            resolved.vb_cable_pack,
            roots.resource_root.join("prerequisites")
        );
        assert!(!resolved.vb_cable_present);

        fs::create_dir_all(roots.resource_root.join("prerequisites").join("vb-cable")).unwrap();
        let resolved = resolve_owned_paths(&roots).expect("template present");
        assert!(resolved.vb_cable_present);
    }
}
