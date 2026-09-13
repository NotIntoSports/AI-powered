pub mod control;
pub mod paths;

pub use control::{
    APP_SCENE_NAME, ObsRuntimeStatus, current_program_scene, ensure_stage, restore_program_scene,
    start_virtual_camera, stop_virtual_camera,
};

pub use paths::{
    OBS_PACKAGED_VERSION, PathError, PathRoots, ResolvedPaths, owned_path, resolve_owned_paths,
};
