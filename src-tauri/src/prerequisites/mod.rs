//! Status-only prerequisite probes. Does not install, elevate, or spawn OBS.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::obs::ResolvedPaths;

pub const OBS_VIRTUAL_CAMERA_CLSID: &str = "{A3FCE0F5-3493-419F-958A-ABA1250EC20B}";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct PrerequisiteStatus {
    pub obs_bundled: bool,
    pub virtual_camera_registered: bool,
    pub virtual_audio_installed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryView {
    Bits32,
    Bits64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryQueryResult {
    pub status: i32,
    pub stdout: String,
}

pub trait CameraRegistryProbe {
    fn query(&self, view: RegistryView) -> &RegistryQueryResult;
}

pub trait AudioDeviceProbe {
    fn enum_output(&self) -> &str;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectedCameraProbe {
    pub bits32: RegistryQueryResult,
    pub bits64: RegistryQueryResult,
}

impl CameraRegistryProbe for InjectedCameraProbe {
    fn query(&self, view: RegistryView) -> &RegistryQueryResult {
        match view {
            RegistryView::Bits32 => &self.bits32,
            RegistryView::Bits64 => &self.bits64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectedAudioProbe {
    pub output: String,
}

impl AudioDeviceProbe for InjectedAudioProbe {
    fn enum_output(&self) -> &str {
        &self.output
    }
}

pub fn obs64_executable(root: &Path) -> PathBuf {
    root.join("bin").join("64bit").join("obs64.exe")
}

pub fn owned_obs_root(paths: &ResolvedPaths) -> &Path {
    if obs64_executable(&paths.obs_runtime).is_file() {
        &paths.obs_runtime
    } else {
        &paths.obs_template
    }
}

pub fn is_obs_bundled(paths: &ResolvedPaths) -> bool {
    obs64_executable(&paths.obs_template).is_file()
        || obs64_executable(&paths.obs_runtime).is_file()
}

pub fn registry_value_references_module(output: &str, module_path: &Path) -> bool {
    let expected = normalize_windows_path(&module_path.to_string_lossy());
    output.lines().any(|line| {
        let Some(offset) = line.to_ascii_uppercase().find("REG_SZ") else {
            return false;
        };
        normalize_windows_path(&line[offset + "REG_SZ".len()..]) == expected
    })
}

pub fn is_obs_virtual_camera_registered(obs_root: &Path, probe: &impl CameraRegistryProbe) -> bool {
    [RegistryView::Bits64, RegistryView::Bits32]
        .into_iter()
        .all(|view| {
            let result = probe.query(view);
            result.status == 0
                && registry_value_references_module(
                    &result.stdout,
                    &virtual_camera_module(obs_root, view),
                )
        })
}

pub fn is_vb_cable_pair_present(output: &str) -> bool {
    let recording =
        contains_ascii_word(output, "cable output") || has_vb_audio_label(output, "麦克风");
    let playback = contains_ascii_word(output, "cable input")
        || contains_ascii_word(output, "cable in")
        || has_vb_audio_label(output, "扬声器");
    recording && playback
}

pub fn report_prerequisite_status(
    paths: &ResolvedPaths,
    camera: &impl CameraRegistryProbe,
    audio: &impl AudioDeviceProbe,
) -> PrerequisiteStatus {
    PrerequisiteStatus {
        obs_bundled: is_obs_bundled(paths),
        virtual_camera_registered: is_obs_virtual_camera_registered(owned_obs_root(paths), camera),
        virtual_audio_installed: is_vb_cable_pair_present(audio.enum_output()),
    }
}

fn virtual_camera_module(obs_root: &Path, view: RegistryView) -> PathBuf {
    obs_root
        .join("data")
        .join("obs-plugins")
        .join("win-dshow")
        .join(view.module_file())
}

fn normalize_windows_path(value: &str) -> String {
    let trimmed = value.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(trimmed);
    unquoted.replace('/', "\\").to_ascii_lowercase()
}

fn contains_ascii_word(haystack: &str, needle: &str) -> bool {
    let haystack = haystack.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let bytes = haystack.as_bytes();
    let mut start = 0;
    while let Some(offset) = haystack[start..].find(&needle) {
        let index = start + offset;
        let before_ok = index == 0 || !is_ascii_word_byte(bytes[index - 1]);
        let after = index + needle.len();
        let after_ok = after == bytes.len() || !is_ascii_word_byte(bytes[after]);
        if before_ok && after_ok {
            return true;
        }
        start = index + 1;
    }
    false
}

fn is_ascii_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn has_vb_audio_label(output: &str, label: &str) -> bool {
    let mut search = output;
    while let Some(index) = search.find(label) {
        let after = search[index + label.len()..].trim_start();
        if let Some(inner) = after.strip_prefix('(')
            && let Some(end) = inner.find(')')
            && inner[..end].contains("VB-Audio")
        {
            return true;
        }
        search = &search[index + label.len()..];
    }
    false
}

impl RegistryView {
    pub const fn module_file(self) -> &'static str {
        match self {
            Self::Bits32 => "obs-virtualcam-module32.dll",
            Self::Bits64 => "obs-virtualcam-module64.dll",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obs::{PathRoots, resolve_owned_paths};
    use std::fs;

    fn roots(directory: &tempfile::TempDir) -> PathRoots {
        let repository = directory.path().to_path_buf();
        PathRoots {
            resource_root: repository.join("resources"),
            data_directory: repository.join("data"),
            repository,
            development: true,
        }
    }

    fn resolved_paths(directory: &tempfile::TempDir) -> ResolvedPaths {
        let roots = roots(directory);
        fs::create_dir_all(
            roots
                .resource_root
                .join("prerequisites")
                .join("obs-portable"),
        )
        .unwrap();
        fs::create_dir_all(&roots.data_directory).unwrap();
        resolve_owned_paths(&roots).expect("template directory present")
    }

    fn write_obs64(root: &Path) {
        let executable = obs64_executable(root);
        fs::create_dir_all(executable.parent().expect("obs64 parent")).unwrap();
        fs::write(&executable, []).unwrap();
    }

    fn registry_line(module_path: &Path) -> String {
        format!("    (Default)    REG_SZ    {}\n", module_path.display())
    }

    fn matching_camera_probe(obs_root: &Path) -> InjectedCameraProbe {
        let module_directory = obs_root.join("data").join("obs-plugins").join("win-dshow");
        InjectedCameraProbe {
            bits64: RegistryQueryResult {
                status: 0,
                stdout: registry_line(&module_directory.join(RegistryView::Bits64.module_file())),
            },
            bits32: RegistryQueryResult {
                status: 0,
                stdout: registry_line(&module_directory.join(RegistryView::Bits32.module_file())),
            },
        }
    }

    fn silent_camera() -> InjectedCameraProbe {
        InjectedCameraProbe {
            bits32: RegistryQueryResult {
                status: 1,
                stdout: String::new(),
            },
            bits64: RegistryQueryResult {
                status: 1,
                stdout: String::new(),
            },
        }
    }

    fn silent_audio() -> InjectedAudioProbe {
        InjectedAudioProbe {
            output: String::new(),
        }
    }

    #[test]
    fn obs_bundled_is_false_when_owned_roots_lack_obs64() {
        let directory = tempfile::tempdir().unwrap();
        let paths = resolved_paths(&directory);
        let status = report_prerequisite_status(&paths, &silent_camera(), &silent_audio());
        assert!(!is_obs_bundled(&paths));
        assert!(!status.obs_bundled);
        assert!(!status.virtual_camera_registered);
        assert!(!status.virtual_audio_installed);
    }

    #[test]
    fn obs_bundled_is_true_when_template_has_obs64() {
        let directory = tempfile::tempdir().unwrap();
        let paths = resolved_paths(&directory);
        write_obs64(&paths.obs_template);
        let status = report_prerequisite_status(&paths, &silent_camera(), &silent_audio());
        assert!(status.obs_bundled);
        assert_eq!(owned_obs_root(&paths), paths.obs_template.as_path());
    }

    #[test]
    fn obs_bundled_is_true_when_runtime_has_obs64() {
        let directory = tempfile::tempdir().unwrap();
        let paths = resolved_paths(&directory);
        write_obs64(&paths.obs_runtime);
        let status = report_prerequisite_status(&paths, &silent_camera(), &silent_audio());
        assert!(status.obs_bundled);
        assert_eq!(owned_obs_root(&paths), paths.obs_runtime.as_path());
    }

    #[test]
    fn virtual_camera_registered_follows_injected_registry_probe() {
        let directory = tempfile::tempdir().unwrap();
        let paths = resolved_paths(&directory);
        write_obs64(&paths.obs_template);
        let camera = matching_camera_probe(&paths.obs_template);
        let status = report_prerequisite_status(&paths, &camera, &silent_audio());
        assert!(status.virtual_camera_registered);

        let mismatched = InjectedCameraProbe {
            bits64: camera.bits64.clone(),
            bits32: RegistryQueryResult {
                status: 0,
                stdout: registry_line(Path::new(r"C:\old-preview\obs-virtualcam-module32.dll")),
            },
        };
        let status = report_prerequisite_status(&paths, &mismatched, &silent_audio());
        assert!(!status.virtual_camera_registered);

        let missing_32 = InjectedCameraProbe {
            bits64: camera.bits64,
            bits32: RegistryQueryResult {
                status: 1,
                stdout: String::new(),
            },
        };
        let status = report_prerequisite_status(&paths, &missing_32, &silent_audio());
        assert!(!status.virtual_camera_registered);
    }

    #[test]
    fn registry_parser_is_case_insensitive_and_rejects_suffix_or_injection() {
        let module_path = Path::new(r"C:\OBS Path\obs-virtualcam-module64.dll");
        assert!(registry_value_references_module(
            r#"(Default) REG_SZ "c:\obs path\OBS-VIRTUALCAM-MODULE64.DLL""#,
            module_path,
        ));
        assert!(!registry_value_references_module(
            r"(Default) REG_SZ C:\OBS Path\obs-virtualcam-module64.dll.old",
            module_path,
        ));
        assert!(!registry_value_references_module(
            r"(Default) REG_SZ C:\OBS Path\obs-virtualcam-module64.dll & calc.exe",
            module_path,
        ));
    }

    #[test]
    fn virtual_audio_installed_detects_vb_cable_pair_from_injected_output() {
        let directory = tempfile::tempdir().unwrap();
        let paths = resolved_paths(&directory);
        let cable_pair = "Device Description: CABLE Input (VB-Audio Virtual Cable)\r\nDevice Description: CABLE Output (VB-Audio Virtual Cable)\r\n";
        let cable_pair_16ch = "Device Description: CABLE In 16 Ch (VB-Audio Virtual Cable)\r\nDevice Description: CABLE Output (VB-Audio Virtual Cable)\r\n";
        let cable_pair_chinese = "Device Description: 扬声器 (VB-Audio Virtual Cable)\r\nDevice Description: 麦克风 (VB-Audio Virtual Cable)\r\n";

        assert!(is_vb_cable_pair_present(cable_pair));
        assert!(is_vb_cable_pair_present(cable_pair_16ch));
        assert!(is_vb_cable_pair_present(cable_pair_chinese));
        assert!(!is_vb_cable_pair_present(
            "Device Description: CABLE Output (VB-Audio Virtual Cable)\r\n"
        ));
        assert!(!is_vb_cable_pair_present(
            "Device Description: CABLE In 16 Ch (VB-Audio Virtual Cable)\r\n"
        ));

        let status = report_prerequisite_status(
            &paths,
            &silent_camera(),
            &InjectedAudioProbe {
                output: cable_pair.to_owned(),
            },
        );
        assert!(status.virtual_audio_installed);
        assert_eq!(
            OBS_VIRTUAL_CAMERA_CLSID,
            "{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
        );
    }
}
