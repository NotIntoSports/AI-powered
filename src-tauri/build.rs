fn main() {
    // tauri.conf.json bundles the AudioBridge sidecar as a resource, but the
    // real executable is a gitignored publish artifact (scripts/
    // build-audio-bridge.ps1). Debug builds only need the resource path to
    // exist — tests inject PCM and never spawn the sidecar — so materialize a
    // text placeholder to keep fresh checkouts (CI, contributors) building.
    // Release builds still fail loudly until the real sidecar is published.
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        let exe = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("../native/AudioBridge/publish/AudioBridge.exe");
        if !exe.exists() {
            std::fs::create_dir_all(exe.parent().unwrap()).expect("create AudioBridge publish dir");
            std::fs::write(&exe, b"placeholder: run scripts/build-audio-bridge.ps1\r\n")
                .expect("write AudioBridge placeholder");
        }
    }
    tauri_build::build();
    // Mock-runtime IPC tests retain Tauri's Windows dialog imports. Unlike the
    // packaged executable, Rust test harnesses do not inherit its resource
    // manifest; without Common Controls v6 they fail before main is entered.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
        // Binaries already receive Tauri's complete resource.lib manifest.
        // Keep that resource and disable the linker's duplicate generated one.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }
}
