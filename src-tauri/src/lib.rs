use tauri::{WebviewUrl, WebviewWindowBuilder};

mod contracts;
mod commands;
mod config;
mod error;

fn navigation_is_allowed(url: &tauri::Url) -> bool {
    if url.scheme() == "tauri" {
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
        .invoke_handler(tauri::generate_handler![commands::foundation_get_status])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("AI Virtual Assistant")
                .inner_size(1180.0, 760.0)
                .min_inner_size(900.0, 620.0)
                .on_navigation(navigation_is_allowed)
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
}
