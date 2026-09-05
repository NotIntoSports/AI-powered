# Third-party notices

The source repository and Windows distribution use third-party components. Their licenses remain applicable to those components.

| Component | License | Source |
| --- | --- | --- |
| Tauri | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-plugin-single-instance | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/api | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| React | MIT | https://github.com/facebook/react |
| livekit-client | Apache-2.0 | https://github.com/livekit/client-sdk-js |
| livekit-api | Apache-2.0 | https://github.com/livekit/rust-sdks |
| wouter | Unlicense | https://github.com/molefrog/wouter |
| zod | MIT | https://github.com/colinhacks/zod |
| rusqlite | MIT | https://github.com/rusqlite/rusqlite |
| sqlite-vec | MIT/Apache-2.0 | https://github.com/asg017/sqlite-vec |
| keyring | MIT OR Apache-2.0 | https://github.com/open-source-cooperative/keyring-rs |
| chrono | MIT OR Apache-2.0 | https://github.com/chronotope/chrono |
| serde | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde_json | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| reqwest | MIT OR Apache-2.0 | https://github.com/seanmonstar/reqwest |
| tungstenite | MIT OR Apache-2.0 | https://github.com/snapview/tungstenite-rs |
| uuid | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| thiserror | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| tracing | MIT | https://github.com/tokio-rs/tracing |
| tracing-subscriber | MIT | https://github.com/tokio-rs/tracing |
| ts-rs | MIT | https://github.com/Aleph-Alpha/ts-rs |
| zeroize | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| sha2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| base64 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| pdf-extract | MIT | https://github.com/jrmuizel/pdf-extract |
| docx-rs | MIT | https://github.com/bokuweb/docx-rs |
| windows-sys | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| NAudio.Wasapi | MIT | https://github.com/naudio/NAudio |

Licenses above are taken from the locked crate / npm / NuGet metadata for the versions this repository depends on. Transitive crates keep their own licenses.

Portable OBS and VB-CABLE are not packaged or started by the current Tauri build. Path and probe code can use a local copy under `resources/prerequisites` if you place one there; that leftover is not a managed OBS / virtual-cam product path.
