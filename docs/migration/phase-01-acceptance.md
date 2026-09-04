# Phase 0–1 Acceptance — Tauri Foundation

Decision: **PASS** on 2026-09-05. The foundation is sufficient to begin writing the React page-shell migration plan. This decision does not authorize deleting or changing the default Electron/Next.js product path.

## Acceptance checklist

- [x] Legacy baseline captured without invented values — unavailable legacy package measurements remain explicitly `not-built`/`not-run` in [baseline-results.md](baseline-results.md).
- [x] Tauri package starts independently of Node server — packaged executable showed a visible window within 15 seconds, had no forbidden service descendants, and exited with code 0 after `WM_CLOSE`.
- [x] Existing Electron path remains operational — 183 desktop-shell tests and the existing Next production build passed.
- [x] Config precedence and fail-closed repair are tested — Rust configuration and AppState recovery tests passed.
- [x] Production secret round trip uses Windows Credential Manager — the normally ignored real-backend test was run explicitly and passed; its temporary credential was deleted by the test.
- [x] SQLite migration and integrity tests pass — migration, PRAGMA, schema, integrity, future-version, and secret-column tests passed.
- [x] Generated TypeScript contracts have no drift — `npm run test:tauri` regenerated bindings and all Node contract tests passed.
- [x] Diagnostics are bounded and redacted — size, rotation, retention, export allowlist, and redaction tests passed.
- [x] Tauri capability has no generic shell/filesystem access — security contracts and source audit passed.
- [x] No author-controlled endpoint exists in new code — endpoint audit returned no matches.
- [x] Dependency decisions and locks are complete — Cargo/npm locks are tracked; the intentionally ignored local ledger records versions, licenses, security, compatibility, cost, and rejected alternatives.

## Fresh command evidence

All timestamps use Asia/Shanghai (`+08:00`). Every required command ran; every exit code was `0`.

| Started | Command | Result |
| --- | --- | --- |
| 2026-09-05 00:39 | `npm run test:tauri` | 26 Rust tests passed, 1 production-backend test intentionally ignored in the aggregate run; 2 security tests, 10 Node contract tests, TypeScript and Vite build passed |
| 2026-09-05 00:39 | `npm run tauri:build` | release executable and `AI Virtual Assistant_0.1.0_x64-setup.exe` produced |
| 2026-09-05 00:39 | `npm run test:tauri-package` | visible window, allowed process tree, clean window close, and private-file scan passed |
| 2026-09-05 00:49 | `npm run test:desktop-shell` | 183 passed, 0 failed |
| 2026-09-05 00:49 | `npm run build` | Next production build passed; 23 static-generation entries completed |
| 2026-09-05 00:49 | `npm audit` | 0 vulnerabilities |
| 2026-09-05 00:34 | `cargo test --manifest-path src-tauri/Cargo.toml secrets::tests::windows_credential_round_trip -- --ignored --exact` | real Windows Credential Manager round trip passed |
| 2026-09-05 01:19 | `cargo test --manifest-path src-tauri/Cargo.toml` | 26 passed, 1 ignored by default; 2 integration tests passed |
| 2026-09-05 01:20 | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | passed with no Clippy warning |
| 2026-09-05 01:20 | `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | passed |
| 2026-09-05 01:20 | `git diff --check` | passed |

The Tauri release build initially encountered transient GitHub download timeouts for its official NSIS toolchain. The final build used the exact upstream assets cached outside the repository after their Tauri-published SHA-1 values were verified. This does not weaken or skip the package gate.

Existing non-failing warnings are recorded rather than hidden: Vite 8 warns about its future native config loader, while the legacy Next path reports Node's experimental SQLite status and a failed traced-file copy for a broken user-workspace `.agents/skills` link. Both builds returned exit code 0; neither warning comes from the packaged Tauri runtime.

## Architectural boundary audit

Run on 2026-09-05 with the plan's exact patterns:

| Search | Result |
| --- | --- |
| `rg -n "@tauri-apps/api|@tauri-apps/plugin" src --glob "!api/commands.ts"` | One legitimate match: `src/api/commands.ts:1`. On Windows, the supplied glob does not exclude that repository-relative path; it is the single approved low-level adapter and `frontend-contract.test.mjs` enforces that boundary. No other match. |
| `rg -n "CONTROL_API_ORIGIN|control_api_token|http://175\.27\.132\.61" src src-tauri` | No matches (`rg` exit 1). |
| `rg -n "api[_-]?key|access[_-]?token|password|secret" config --glob "!local.example.json"` | No matches (`rg` exit 1). |
| `rg -n "shell:allow-(execute|spawn)|\*" src-tauri/capabilities` | No matches (`rg` exit 1). |

## Scope of the pass

The measured Tauri artifact is only the foundation. Its current installer, executable, startup, memory, and CPU measurements in [baseline-results.md](baseline-results.md) must not be compared as if all product features had already migrated. The authoritative remaining capability routing is [current-capability-inventory.md](current-capability-inventory.md).
