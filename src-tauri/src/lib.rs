use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod app_state;
mod commands;
pub mod config;
pub mod contracts;
pub mod database;
pub mod diagnostics;
pub mod error;
pub mod materials;
pub mod providers;
pub mod runtime;
pub mod secrets;
pub mod services;
pub mod sessions;

fn navigation_is_allowed(url: &tauri::Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }

    // Tauri v2 serves the packaged Windows app from http://tauri.localhost
    // (WebView2). Allow exactly that origin — http scheme, exact host, no port —
    // so a release build does not white-screen. This is fail-closed: a lookalike
    // host such as tauri.localhost.evil.com, any port, or https is rejected below.
    if url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none() {
        return true;
    }

    cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::foundation_get_status,
            commands::diagnostics_export,
            commands::config_get_startup_state,
            commands::config_get_public,
            commands::model_provider_save,
            commands::model_provider_test,
            commands::model_provider_discover,
            commands::model_provider_activate,
            commands::model_provider_delete,
            commands::speech_route_save,
            commands::speech_route_test,
            commands::speech_route_activate,
            commands::speech_route_delete,
            commands::role_profile_save,
            commands::role_profile_copy,
            commands::role_profile_activate,
            commands::role_profile_delete,
            commands::embedding_config_save,
            commands::embedding_config_test,
            commands::embedding_config_activate,
            commands::embedding_config_delete,
            commands::livekit_settings_save,
            commands::livekit_settings_test,
            commands::livekit_settings_enable,
            commands::material_list,
            commands::material_import,
            commands::material_search,
            commands::material_delete,
            commands::config_restore_last_good,
            commands::config_restore_defaults,
            commands::open_app_directory,
        ])
        .setup(|app| {
            let data_directory = app.path().app_data_dir()?;
            let config_root = app.path().config_dir()?;
            let config_location = config::locate_config(
                &std::env::args_os().collect::<Vec<_>>(),
                &std::env::vars_os()
                    .filter(|(key, _)| key == "AI_VIRTUAL_ASSISTANT_CONFIG")
                    .filter_map(|(key, value)| key.into_string().ok().map(|key| (key, value)))
                    .collect(),
                &config::ConfigDirs {
                    repository: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .expect("manifest has parent")
                        .to_path_buf(),
                    roaming_app_data: config_root,
                },
                cfg!(debug_assertions),
            )?;
            app.manage(app_state::AppState::production(app_state::AppPaths {
                logs_directory: data_directory.join("logs"),
                config_path: config_location.path,
                data_directory,
            })?);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("AI Virtual Assistant")
                .inner_size(1180.0, 760.0)
                .min_inner_size(900.0, 620.0)
                .on_navigation(navigation_is_allowed)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run AI Virtual Assistant");
}

#[cfg(test)]
mod tests {
    use super::navigation_is_allowed;

    #[test]
    fn blocks_remote_navigation() {
        assert!(!navigation_is_allowed(
            &"https://example.com/path".parse().unwrap()
        ));
        assert!(!navigation_is_allowed(
            &"http://127.0.0.1:3000/".parse().unwrap()
        ));
    }

    #[test]
    fn allows_packaged_and_exact_development_origins() {
        assert!(navigation_is_allowed(
            &"tauri://localhost/index.html".parse().unwrap()
        ));
        assert!(navigation_is_allowed(
            &"http://127.0.0.1:1420/".parse().unwrap()
        ));
    }

    #[test]
    fn allows_packaged_windows_origin() {
        assert!(navigation_is_allowed(
            &"http://tauri.localhost/index.html".parse().unwrap()
        ));
    }

    #[test]
    fn blocks_remote_spoof() {
        assert!(!navigation_is_allowed(
            &"http://tauri.localhost.evil.com/index.html"
                .parse()
                .unwrap()
        ));
    }

    #[test]
    fn blocks_https_remote() {
        assert!(!navigation_is_allowed(
            &"https://evil.com/".parse().unwrap()
        ));
    }
}
