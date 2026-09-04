use std::{fs, path::PathBuf};

use serde_json::Value;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn capability_is_explicit_and_has_no_generic_process_or_filesystem_access() {
    let text = fs::read_to_string(manifest_dir().join("capabilities/main.json")).unwrap();
    let capability: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(
        capability["permissions"],
        serde_json::json!([
            "core:default",
            "allow-foundation-get-status",
            "allow-secret-set",
            "allow-secret-delete",
            "allow-secret-status",
            "allow-diagnostics-export",
            "allow-config-get-startup-state",
            "allow-config-restore-last-good",
            "allow-config-restore-defaults",
            "allow-open-app-directory"
        ])
    );
    let lower = text.to_ascii_lowercase();
    for forbidden in [
        "shell:allow-execute",
        "shell:allow-spawn",
        "fs:",
        "http://",
        "https://",
        "\"*\"",
    ] {
        assert!(
            !lower.contains(forbidden),
            "forbidden capability token: {forbidden}"
        );
    }
}

#[test]
fn csp_navigation_child_windows_and_single_instance_are_fail_closed() {
    let config: Value =
        serde_json::from_str(&fs::read_to_string(manifest_dir().join("tauri.conf.json")).unwrap())
            .unwrap();
    let csp = config["app"]["security"]["csp"].as_str().unwrap();
    assert!(!csp.contains("unsafe-eval"));
    assert!(!csp.contains("script-src http:"));
    assert!(!csp.contains("script-src https:"));
    assert!(!csp.contains("connect-src http:") && !csp.contains("connect-src https:"));

    let source = fs::read_to_string(manifest_dir().join("src/lib.rs")).unwrap();
    assert!(source.contains("tauri_plugin_single_instance::init"));
    assert!(source.contains("on_navigation(navigation_is_allowed)"));
    assert!(source.contains("on_new_window"));
    assert!(source.contains("NewWindowResponse::Deny"));
    assert!(source.contains("cfg!(debug_assertions)"));
}
