# Phase 3 Role, Embedding, And LiveKit Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining Phase 3 desktop-only role, embedding, and optional LiveKit settings with tested persistence, Credential Manager isolation, typed IPC, and React editors.

**Architecture:** Rust owns config mutation, secrets, token creation, validation, and third-party requests. React consumes only redacted DTOs through `src/api/commands.ts`. Embedding reuses the existing OpenAI-compatible reqwest client; LiveKit uses only the official access-token crate in this phase.

**Tech Stack:** Tauri 2, Rust 2024, reqwest 0.13.4, livekit-api 0.6.4 with `access-token` only, React 19, TypeScript 5.8, Vite 8, Vitest 5, ts-rs 12.

**Spec:** `docs/superpowers/specs/2026-09-05-phase-3-remaining-service-settings-design.md`

## Global Constraints

- Work directly on `main`; do not create a branch or worktree.
- Do not touch or stage `.codex-tmp/` or `videos/`.
- No login, management web, Control API, PostgreSQL, Nginx, Python Agent, or author-owned server.
- Credentials live only in Windows Credential Manager; never JSON, SQLite, logs, diagnostics, backups, URLs, fixtures, frontend-returned state, or Git.
- S3-compatible storage is deferred. C# AudioBridge remains unchanged.
- Every third-party request has an explicit timeout, bounded response, no redirects, no system proxy, and sanitized errors.
- Follow red-green-refactor. Each task ends with a reviewable commit.

---

### Task 1: Lock Dependency And Versioned Config Contracts

**Files:**
- Modify locally: `docs/dependency-decisions.md`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/config/mod.rs`
- Modify: `src-tauri/src/config/tests.rs`
- Modify: `config/local.example.json`

**Interfaces:**
- Produces `RoleProfileConfig`, `EmbeddingConfig`, `EmbeddingDistance::Cosine`, and `LiveKitConfig`.
- Produces root `active_role_profile_id`, `KnowledgeConfig.embedding_configs/active_embedding_config_id`, and `TransportConfig.livekit`.

- [ ] **Step 1: Record open-source decisions**

Append: official `livekit-api 0.6.4`, Apache-2.0, actively maintained, Windows-supported, `default-features=false, features=["access-token"]`; no services/signal/media SDK. Embedding adds no SDK and uses the official OpenAI-compatible `POST /embeddings` shape through existing reqwest. Record license, MSRV uncertainty, dependency tree, data flow, secret handling, package cost, and why S3 and full LiveKit SDK are deferred.

- [ ] **Step 2: Write failing compatibility/invariant tests**

Add literal JSON tests proving legacy `RoleProfile {id,instructions}`, `embeddingProviderId`, and `livekitUrl` load safely into disabled/unconfigured canonical state. Add failures for duplicate/dangling active IDs, inconsistent derived `active`, active-but-not-ready entries, role limits (name nonempty, prompt 32 KiB, opening 4 KiB, style 8 KiB), dimensions outside 1..=65536, unsafe LiveKit URL, and noncanonical refs.

Core assertion:

```rust
let config = AppConfigV1::from_json(legacy_json).unwrap();
assert_eq!(config.role_profiles[0].system_prompt, "Ask one question");
assert!(!config.transport.livekit.enabled);
assert!(config.knowledge.embedding_configs.is_empty());
```

- [ ] **Step 3: Verify RED**

Run `cargo test --manifest-path src-tauri/Cargo.toml config::tests -- --nocapture`.

Expected: compile failure because rich fields do not exist.

- [ ] **Step 4: Implement canonical types**

```rust
pub struct RoleProfileConfig {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub opening_message: String,
    pub style_instructions: String,
    pub active: bool,
    pub config_version: u32,
}
pub struct EmbeddingConfig {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub dimensions: u32,
    pub distance: EmbeddingDistance,
    pub normalized: bool,
    pub active: bool,
    pub ready: bool,
    pub status: Option<String>,
    pub config_version: u32,
}
pub struct LiveKitConfig {
    pub enabled: bool,
    pub url: Option<String>,
    pub api_key: Option<SecretSlot>,
    pub api_secret: Option<SecretSlot>,
    pub ready: bool,
    pub status: Option<String>,
    pub config_version: u32,
}
```

Use private compatibility DTOs/custom deserialization only at version-1 input. Serialization emits the canonical form. LiveKit refs are exactly `transport/livekit/api-key` and `transport/livekit/api-secret`.

- [ ] **Step 5: Verify GREEN and dependency shape**

Run config tests and:
```powershell
cargo tree --manifest-path src-tauri/Cargo.toml -p livekit-api -e features
cargo tree --manifest-path src-tauri/Cargo.toml | Select-String "livekit-(ffi|protocol)|webrtc|openh264"
```
Expected: tests pass; media/FFI/codec search is empty.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/config/mod.rs src-tauri/src/config/tests.rs config/local.example.json
git commit -m "feat(tauri): define role embedding and LiveKit settings"
```

### Task 2: Atomic Role Profile Lifecycle

**Files:**
- Create: `src-tauri/src/services/roles.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Interfaces:** Produces `RoleProfileSaveInput`, `RoleProfileCopyInput`, and `RoleProfileService::save/copy/activate/delete`.

- [ ] **Step 1: Write failing tests**

Cover create/edit/copy, duplicate-copy rejection, IDs and all length limits, version increment, one active role, deletion clearing active ID, and missing role. Happy path:

```rust
let saved = service.save(RoleProfileSaveInput {
    id: "interviewer".into(), name: "Interviewer".into(),
    system_prompt: "Ask one question".into(),
    opening_message: "Hello".into(), style_instructions: "Concise".into(),
}).unwrap();
assert_eq!(saved.config_version, 1);
assert!(service.activate("interviewer").unwrap().active);
```

- [ ] **Step 2: Verify RED**

Run `cargo test --manifest-path src-tauri/Cargo.toml services::tests::role -- --nocapture`.

- [ ] **Step 3: Implement service**

Trim/validate fields before one `ConfigStore::update`. Editing increments version and resets active state; copying requires a distinct unused ID and starts version 1. Activation atomically synchronizes root ID and derived flags. Deleting active clears the root ID.

- [ ] **Step 4: Verify GREEN and commit**

Run the role tests, then:
```powershell
git add src-tauri/src/services
git commit -m "feat(tauri): manage local role profiles"
```

### Task 3: Bounded Embedding Probe And Service

**Files:**
- Create: `src-tauri/src/providers/embedding.rs`
- Modify: `src-tauri/src/providers/mod.rs`
- Modify: `src-tauri/src/providers/tests.rs`
- Create: `src-tauri/src/services/embeddings.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/providers.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Interfaces:**
- Produces `EmbeddingProbe::embed(endpoint, credential, model_id, dimensions, input) -> Result<Vec<f32>, EmbeddingError>`.
- Produces `EmbeddingConfigSaveInput`, `EmbeddingTestResult`, and `EmbeddingService::save/test/activate/delete`.

- [ ] **Step 1: Write failing probe tests**

Loopback fixtures assert `POST {base}/embeddings`, optional bearer auth, and body:
```json
{"input":"AI Virtual Assistant embedding connectivity test","model":"embed-model","dimensions":3,"encoding_format":"float"}
```
Cover valid floats, unauthorized, timeout, redirect, response over 1 MiB, malformed JSON, non-finite values, and dimension mismatch. Public errors expose only stable codes.

- [ ] **Step 2: Verify RED**

Run `cargo test --manifest-path src-tauri/Cargo.toml providers::tests::embedding -- --nocapture`.

- [ ] **Step 3: Implement minimal probe**

Reuse/refactor the existing reqwest builder. Normalize `/v1` to `/v1/embeddings`; reject userinfo/query/fragment; timeout 10 seconds; cap response at 1 MiB. Deserialize only `data[0].embedding`. Never log input, vector, body, credential, or full URL.

- [ ] **Step 4: Write failing service tests**

Cover provider/model/dimension validation, save resetting readiness, provider edits invalidating references, internal credential read, exact dimension, failed retest deactivation, activation-before-test rejection, single active config, version staleness, and delete.

- [ ] **Step 5: Implement service**

Save as `ready=false,active=false,status=not_tested`. Test with the fixed non-user phrase and commit ready only if version is unchanged. Activation requires ready/current version. Provider changes invalidate referenced embedding configs alongside voice routes.

- [ ] **Step 6: Verify and commit**

Run provider embedding and service embedding tests, then:
```powershell
git add src-tauri/src/providers src-tauri/src/services
git commit -m "feat(tauri): validate embedding configurations"
```

### Task 4: Transactional LiveKit Settings And Probe

**Files:**
- Create: `src-tauri/src/providers/livekit.rs`
- Modify: `src-tauri/src/providers/mod.rs`
- Modify: `src-tauri/src/providers/tests.rs`
- Create: `src-tauri/src/services/livekit.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/tests.rs`

**Interfaces:**
- Produces `LiveKitProbe::test(url, api_key, api_secret) -> Result<(), LiveKitError>`.
- Produces `LiveKitSettingsSaveInput`, `LiveKitTestResult`, and `LiveKitSettingsService::save/test/set_enabled`.

- [ ] **Step 1: Write failing token/probe tests**

Verify official access-token JWT creation has a short expiry and RoomService grant. Loopback fixtures assert an authenticated bounded request to `/twirp/livekit.RoomService/ListRooms`. Cover bad URL, missing credentials, unauthorized, timeout, redirect, oversized/malformed response, and secret/token marker absence.

- [ ] **Step 2: Verify RED**

Run `cargo test --manifest-path src-tauri/Cargo.toml providers::tests::livekit -- --nocapture`.

- [ ] **Step 3: Implement probe**

Add:
```toml
livekit-api = { version = "=0.6.4", default-features = false, features = ["access-token"] }
```
Convert only ws→http and wss→https. Create JWT in `Zeroizing<String>`, call RoomService with existing bounded reqwest policy, and drop token immediately. Do not add the signal or realtime SDK.

- [ ] **Step 4: Write failing transaction tests**

Cover two-secret save, independent blank preservation, partial secret failure, config failure rollback in reverse order, rollback failure, canonical refs, readiness reset, successful test, failed retest disabling LiveKit, enable-before-test rejection, and disable without credential reads.

- [ ] **Step 5: Implement settings service**

Under the application service lock, remember old values, replace nonblank inputs in key-then-secret order, commit config, and roll back changed values in reverse on failure. Test requires both configured slots. Failure writes `ready=false,enabled=false,status=test_failed`; enabling requires ready/current version, while disabling performs no network or secret read.

- [ ] **Step 6: Verify and commit**

Run LiveKit provider/service tests, then:
```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/providers src-tauri/src/services
git commit -m "feat(tauri): configure optional LiveKit transport"
```

### Task 5: Typed IPC And Least Privilege

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/application.toml`
- Modify: `src-tauri/capabilities/main.json`
- Generate: `src/generated/bindings.ts`
- Modify: `src/api/commands.ts`
- Modify tests: `src/api/commands.test.ts`, `src-tauri/tests/security_contract.rs`, `tests/tauri/frontend-contract.test.mjs`
- Modify after review: `tests/tauri/security-surface-baseline.json`

**Interfaces:** Adds role save/copy/activate/delete; embedding save/test/activate/delete; LiveKit save/test/enable commands and matching camelCase wrappers.

- [ ] **Step 1: Write failing command/permission tests**

Assert each command is registered once, has one explicit permission and wrapper, and only input DTOs may contain transient `apiKey/apiSecret`. Assert output DTOs and results never contain secrets and no generic HTTP/fs/shell/process/secret capability appears.

- [ ] **Step 2: Verify RED**

Run Rust security tests, adapter Vitest, and frontend contract Node tests. Expected: failures on missing surface.

- [ ] **Step 3: Implement thin async commands**

Every command obtains `service_guard`, calls one domain service, and maps ID/URL/model/dimensions/role errors to `PublicError.field`. Timeout/request failures are retryable; authentication/configuration errors are not.

- [ ] **Step 4: Generate bindings, wrappers, and permissions**

Run the Rust binding export test. Add exact wrappers and one permission stanza/capability entry per command. LiveKit output contains only `SecretSlot` state.

- [ ] **Step 5: Review and update security hashes**

Run the drift test, inspect every pinned diff, recompute CRLF→LF SHA-256 only for intentional files, and rerun the test.

- [ ] **Step 6: Verify and commit**

Run `npm run test:tauri`, then:
```powershell
git add src-tauri/src src-tauri/permissions/application.toml src-tauri/capabilities/main.json src-tauri/tests/security_contract.rs src/generated/bindings.ts src/api tests/tauri
git commit -m "feat(tauri): expose role embedding and LiveKit settings"
```

### Task 6: React Editors

**Files:**
- Create: `src/features/roles/role-editor.tsx` and test
- Create: `src/features/services/embedding-editor.tsx` and test
- Create: `src/features/services/livekit-editor.tsx` and test
- Modify: `src/screens/settings/settings-page.tsx` and test
- Modify: `src/screens/services/services-page.tsx` and test
- Modify: `src/styles/shell.css`

**Interfaces:** Consumes only generated DTOs and `src/api/commands.ts`.

- [ ] **Step 1: Write failing role UI tests**

Cover loading/error/empty, create/edit/copy/delete/activate, field limits, active badge, reload after mutation, field errors, and absence of login/fetch/`/api/`/management origin/low-level Tauri imports.

- [ ] **Step 2: Implement role editor**

Use controlled native fields. Use an inline two-step delete state, not browser prompt. Preserve heading/navigation semantics and no new UI dependency.

- [ ] **Step 3: Write failing Embedding/LiveKit UI tests**

Embedding: provider/model, dimensions min/max, cosine/normalized, test gating activation, failed retest, delete. LiveKit: default disabled, URL, two password inputs, blank preservation, both cleared in `finally`, test gating enable, disable, IPC rejection, and media data-destination copy.

- [ ] **Step 4: Implement service editors**

Keep credentials only in transient component state. Reload public config after mutation, expose only configured flags, disable concurrent actions, and show field errors. Explain that Embedding sends test/chunk/query text to the chosen endpoint and LiveKit sends media only when later explicitly used.

- [ ] **Step 5: Compose and style**

Settings gets roles; Services gets Embedding and LiveKit below current panels. Ensure labels, status regions, visible focus, and no horizontal overflow at 360 px.

- [ ] **Step 6: Verify and commit**

```powershell
npm run test:tauri-ui -- src/features/roles src/features/services src/screens/settings src/screens/services
npm run build:tauri-ui
git add src/features src/screens/settings src/screens/services src/styles/shell.css
git commit -m "feat(tauri-ui): edit roles embedding and LiveKit"
```

### Task 7: Acceptance And GitHub Push

**Files:**
- Create: `docs/migration/phase-03-remaining-settings-acceptance.md`
- Modify production/tests only for review findings

- [ ] **Step 1: Run Credential Manager smoke**

Explicitly run ignored Windows credential tests for provider and LiveKit refs. Verify set/read/replace/delete and no leftover test credential.

- [ ] **Step 2: Independent review**

Review Tasks 1-6 for spec compliance, secret exposure, crash consistency, URL injection, stale activation, permission expansion, and UI rejection handling. Fix every Critical/Important issue with a failing regression test first and commit fixes.

- [ ] **Step 3: Run final gates**

```powershell
npm run test:tauri
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm audit
Push-Location src-tauri; cargo audit --no-fetch; Pop-Location
npm run test:desktop-shell
npm run build
npm run tauri:build
git diff --check
git status --short --branch
```

Expected: all exit 0; only `.codex-tmp/` and `videos/` remain untracked. Existing allowed RustSec warnings may remain only if unchanged and documented.

- [ ] **Step 4: Inspect boundaries**

Scan tracked Tauri files, generated bindings, built UI, example config, diagnostics, and NSIS bundle for credential markers, secrets in output DTOs, generic commands, `/api/`, management origins, arbitrary capabilities, and packaged Node/Python/Go processes.

- [ ] **Step 5: Record acceptance and commit**

Record dependencies/licenses, commits, exact test counts, installer path/size, credential smoke, review fixes, audit warnings, and next phase (local materials, chunks, FTS5, embeddings, sqlite-vec).

```powershell
git add -f docs/migration/phase-03-remaining-settings-acceptance.md
git commit -m "docs: accept remaining Phase 3 settings"
```

- [ ] **Step 6: Push**

Confirm status contains only the two preserved untracked directories, run `git push origin main`, and verify `git rev-list --count '@{upstream}..HEAD'` returns `0`.

## Self-Review

- Spec coverage: roles, Embedding, optional LiveKit, config compatibility, secrets, probes, IPC, permissions, UI, audits, acceptance, and push map to Tasks 1-7.
- Deferred scope is explicit: S3, materials/vector persistence, Runtime/media transport, legacy deletion, and AudioBridge rewrite.
- Names are consistent across config, services, IPC, and UI.
- No placeholder or unspecified error-handling step remains.

