# Phase 3 remaining settings acceptance

Date: 2026-09-05  
Branch: `main`  
Range: `0bbce84`..`e3c6f37`

## Product surface

Local-first Tauri desktop monolith. No login, management web, Control API, PostgreSQL, Nginx, Python Agent, or author-owned server. Credentials live only in Windows Credential Manager. S3-compatible object storage remains deferred.

## Reused dependencies

| Dependency | License | Role |
| --- | --- | --- |
| `livekit-api =0.6.4` (`default-features = false`, `access-token`) | Apache-2.0 | Short-lived RoomService JWT only; no signal/media/WebRTC |
| `reqwest =0.13.4` (`blocking`, `json`, `rustls`) | MIT OR Apache-2.0 | Bounded OpenAI-compatible and LiveKit HTTP probes |
| `chacha20 0.10.2` (lock pin, transitive via `rand 0.10.2`) | MIT OR Apache-2.0 | Replaces yanked `0.10.0` |
| `base64 =0.22.1` (dev-only) | MIT OR Apache-2.0 | JWT payload assertions in LiveKit probe tests |

## Implementation commits

- `0bbce84` / `175c9c1` — config contracts and legacy role quarantine
- `4ba2dd8` / `113ee6c` — role profile lifecycle
- `22117fa` — embedding probe and service
- `ccfb2ff` — LiveKit settings, probe, and `chacha20` pin
- `f8b69e2` — typed IPC, permissions, diagnostic projection
- `9bd2572` — role / Embedding / LiveKit editors
- `e3c6f37` — review fix: accept `ws://` LiveKit URLs (HTML `type="url"` rejected them)

## Review

Independent review of Tasks 1–6 found one Important UI issue: the LiveKit URL field used `type="url"`, which can block official `ws://` control URLs. Fixed by `e3c6f37` with a regression that submits `ws://127.0.0.1:7880`.

Deferred minor: role `config_version` saturates at `u32::MAX`.

No Critical findings. Secrets stay out of JSON, SQLite, logs, diagnostics, backups, URLs, fixtures, frontend-returned state, and Git. Diagnostic export strips `systemPrompt` / `openingMessage` / `styleInstructions`. Output DTOs expose LiveKit `apiKey`/`apiSecret` only as `SecretSlot`.

## Credential Manager smoke

`cargo test --manifest-path src-tauri/Cargo.toml --lib secrets::tests::windows_credential_round_trip -- --ignored` passed. Covered `providers/openai/api-key`, `transport/livekit/api-key`, and `transport/livekit/api-secret` under a unique `com.aivirtualassistant.desktop.test/{uuid}` namespace, with Drop cleanup.

## Gates (2026-09-05)

| Gate | Result |
| --- | --- |
| `npm run test:tauri` | 90 Rust lib + 3 security + 88 vitest + 21 node contract; UI build OK |
| ignored Windows credential test | pass |
| `cargo clippy --all-targets -- -D warnings` | pass |
| `cargo fmt -- --check` | pass |
| `npm audit` | 0 vulnerabilities |
| `cargo audit --no-fetch` | 0 vulnerabilities; **16** allowed warnings (GTK3/UNIC/event-listener/glib). Yanked `chacha20 0.10.0` warning is gone. |
| `npm run test:desktop-shell` | 183 passed |
| `npm run build` | Next.js 15.5.22 exit 0 |
| `npm run tauri:build` | exit 0 |
| `git diff --check` | clean |

Installer: `src-tauri/target/release/bundle/nsis/AI Virtual Assistant_0.1.0_x64-setup.exe` (4,568,292 bytes).

## Boundary notes

Tracked Tauri sources, generated bindings, and the built UI contain credential values only as transient input DTO fields (`ProviderSaveInput.apiKey`, `LiveKitSettingsSaveInput.apiKey`/`apiSecret`). Output types use `SecretSlot`. No generic HTTP/fs/shell/process/secret capabilities were added. Real third-party Embedding/LiveKit compatibility was not exercised with paid credentials.

## Next phase

Local materials, chunks, FTS5, embeddings, and `sqlite-vec`.
