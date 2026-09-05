# Provider And Voice Route Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase 3's approved desktop-only provider, model discovery, connectivity testing, voice-route configuration, and Services UI without login or any management server.

**Architecture:** Rust owns configuration mutation, Credential Manager access, third-party HTTP, validation, and error redaction. React renders one Services page and calls only typed functions in `src/api/commands.ts`. Provider adapters are protocol-oriented and receive secrets only for one request; configuration JSON stores only a secret reference and configured flag.

**Tech Stack:** Tauri 2, Rust 2024, reqwest 0.13.4, React 19, TypeScript 5.8, Vite 8, Vitest 5, ts-rs 12.

**Spec:** `docs/superpowers/specs/2026-09-04-tauri-local-monolith-design.md`

## Global Constraints

- Work directly on `main`; do not create a branch or worktree.
- Do not touch or stage `.codex-tmp/` or `videos/`.
- Desktop has no login and does not call the legacy management web, Control API, PostgreSQL, Nginx, or Python Agent.
- API keys live only in Windows Credential Manager; never JSON, SQLite, logs, diagnostics, backups, frontend-returned state, or Git.
- The config file is the default local non-secret store and every write is validated and atomic with a last-good copy.
- Exactly one voice route may be active; route activation requires a successful route test against the current configuration version.
- Third-party failures expose stable bounded error codes/messages, never raw bodies, headers, full URLs, prompts, audio, or secrets.
- Normal automated tests use fakes/local fixtures and never real credentials or paid APIs.
- All new production behavior follows red-green-refactor and every task ends with an independently reviewable commit.

---

### Task 1: Lock The HTTP Dependency And Provider Contracts

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/src/providers/mod.rs`
- Create: `src-tauri/src/providers/openai_compatible.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/providers/tests.rs`
- Local record only: `docs/dependency-decisions.md`

**Interfaces:**
- Produces: `ProviderProbe::discover_models(&self, endpoint: &ProviderEndpoint, credential: Option<&str>) -> Result<Vec<DiscoveredModel>, ProviderError>`.
- Produces: `ProviderEndpoint { provider_id, base_url }`, `DiscoveredModel { id }`, and stable `ProviderError::code()`.
- Uses OpenAI-compatible `GET {normalized_base_url}/models`, 10 second total timeout, no redirects, 1 MiB response limit, and optional bearer authorization.

- [ ] **Step 1: Record the dependency decision**

Append the verified `reqwest 0.13.4` choice to ignored `docs/dependency-decisions.md`: MIT OR Apache-2.0, MSRV 1.85, active upstream releases, Windows-compatible rustls, `blocking + json + rustls` only, no cookies/compression/redirects/system proxy, request data sent only to the user-entered endpoint, and no paid cost beyond the user's provider.

- [ ] **Step 2: Write failing provider parsing and URL tests**

Add tests requiring `/v1` and `/v1/` to normalize to `/v1/models`, deduplicated/sorted model IDs, non-http(s) rejection, redirect rejection, bounded response bodies, and stable timeout/auth/malformed-JSON codes without raw response content.

- [ ] **Step 3: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml providers::tests -- --nocapture`

Expected: FAIL because `providers` and its contracts do not exist.

- [ ] **Step 4: Implement the minimal adapter**

Add `reqwest = { version = "=0.13.4", default-features = false, features = ["blocking", "json", "rustls"] }`. Build one reusable blocking client with explicit timeout and redirect policy. Deserialize only `{ data: [{ id }] }`; use bounded byte reads and sanitized errors.

- [ ] **Step 5: Verify GREEN and dependency safety**

Run: `cargo test --manifest-path src-tauri/Cargo.toml providers::tests`

Run: `cargo tree --manifest-path src-tauri/Cargo.toml -i reqwest`

Expected: provider tests PASS and exactly one reqwest version is present.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/providers src-tauri/src/lib.rs
git commit -m "feat(tauri): add bounded OpenAI-compatible provider probe"
```

### Task 2: Add Atomic Provider CRUD And Secret Lifecycle

**Files:**
- Modify: `src-tauri/src/config/store.rs`
- Create: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/src/services/providers.rs`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/services/tests.rs`

**Interfaces:**
- Consumes: `ProviderProbe`, `ConfigStore`, and `SecretService`.
- Produces: `ProviderService::save(input)`, `delete(provider_id)`, `test(provider_id)`, `discover(provider_id)`, and `activate(provider_id)`.
- Produces: `ProviderSaveInput { id, name, base_url, api_key: Option<String> }`, `ProviderTestResult { provider_id, reachable, model_count }`, `ModelDiscoveryResult { provider_id, models }`.

- [ ] **Step 1: Write failing service tests**

Cover create/update with and without a key, blank key preservation, missing configured key, activation, duplicate ID/update semantics, referenced-provider delete rejection, unreferenced delete credential cleanup, failed config write rollback of a newly written credential, and public outputs containing no key material.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::tests::provider -- --nocapture`

Expected: FAIL because `ProviderService` is missing.

- [ ] **Step 3: Add whole-config atomic mutation**

Add `ConfigStore::update<F>(&self, mutation: F) -> Result<AppConfigV1, ConfigError>` where `F: FnOnce(&mut AppConfigV1) -> Result<(), ConfigError>`. It loads, mutates, validates, serializes, atomically replaces primary and last-good files, then returns committed config.

- [ ] **Step 4: Implement provider lifecycle**

Use canonical reference `providers/{provider_id}/api-key`. Validate IDs before secret access. On save with a key, remember the prior secret, set the new secret, commit config, and restore/delete the secret if config commit fails. On delete, reject speech/knowledge references, commit config first, then delete the now-unreferenced credential; return an explicit cleanup error if Credential Manager deletion fails.

- [ ] **Step 5: Verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::tests::provider`

Expected: PASS with no secret values in serialized results or fixture config files.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/config/store.rs src-tauri/src/services src-tauri/src/app_state.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): manage providers and credential lifecycle"
```

### Task 3: Add Voice Route Save, Test, Activate, And Delete

**Files:**
- Create: `src-tauri/src/services/voice_routes.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/config/mod.rs`
- Test: `src-tauri/src/services/tests.rs`
- Test: `src-tauri/src/config/tests.rs`

**Interfaces:**
- Produces: `VoiceRouteService::save(input)`, `test(route_id)`, `activate(route_id)`, and `delete(route_id)`.
- Produces: `VoiceRouteSaveInput` matching public route fields except derived `active`, `ready`, `status`, and `config_version`.
- Produces: `VoiceRouteTestResult { route_id, ready, checked_provider_ids }`.

- [ ] **Step 1: Write failing route invariant tests**

Cover cascaded routes requiring ASR/LLM/TTS provider and model IDs; E2E routes requiring E2E provider/model only; forbidden cross-mode fields; existing provider references; save resetting readiness when inputs change; distinct provider probes; failed probe leaving route inactive/not ready; activation rejected before test; stale test rejected after config change; activation setting exactly one route active; delete clearing the active ID.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::tests::voice_route -- --nocapture`

Expected: FAIL because route services and mode validation are absent.

- [ ] **Step 3: Implement strict route validation**

Keep common reference validation in `AppConfigV1::validate`; put mode-specific completeness/exclusivity in the route service so incomplete drafts live only in form state, never config.

- [ ] **Step 4: Implement test and activation state**

Increment a monotonic config version on relevant provider/route changes. A successful test writes `ready=true`, status `ready`, and the tested version. Activation verifies readiness/version and atomically sets both `active_voice_route_id` and every route's derived `active` flag.

- [ ] **Step 5: Verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::tests::voice_route config::tests`

Expected: PASS; every persisted config has zero or one active route and no dangling reference.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/services src-tauri/src/config
git commit -m "feat(tauri): manage tested voice routes atomically"
```

### Task 4: Expose Typed Tauri Commands With Least Privilege

**Files:**
- Modify: `src-tauri/src/contracts.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/application.toml`
- Modify: `src-tauri/capabilities/main.json`
- Modify: `src/generated/bindings.ts` (generated by Rust test only)
- Modify: `src/api/commands.ts`
- Test: `src-tauri/src/commands.rs`
- Test: `src/api/commands.test.ts`
- Test: `src-tauri/tests/security_contract.rs`
- Test: `tests/tauri/frontend-contract.test.mjs`

**Interfaces:**
- Produces IPC: `model_provider_save/test/discover/activate/delete` and `speech_route_save/test/activate/delete`.
- Produces matching camelCase wrappers in `src/api/commands.ts`.

- [ ] **Step 1: Write failing command, adapter, and permission tests**

Assert exact names/arguments/result DTOs, generated binding coverage, one explicit permission per command, no wildcard/fs/shell/network URL grant, and no low-level Tauri import outside the adapter.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::tests security_contract`

Run: `npm run test:tauri-ui -- src/api/commands.test.ts`

Expected: FAIL on missing commands/wrappers/permissions.

- [ ] **Step 3: Implement thin commands and generate bindings**

Commands call services and translate domain errors to `CommandResult<T>`. Never include submitted key in returns, debug formatting, diagnostics, or public errors. Generate TypeScript through the binding export test.

- [ ] **Step 4: Add least-privilege permissions and wrappers**

Register every command, add exact `allow-*` permissions only to `main`, and add centralized wrappers.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:tauri`

Expected: all Rust, Vitest, contract, security, type, and Vite checks PASS.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/contracts.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/permissions/application.toml src-tauri/capabilities/main.json src/generated/bindings.ts src/api/commands.ts src/api/commands.test.ts src-tauri/tests/security_contract.rs tests/tauri/frontend-contract.test.mjs tests/tauri/security-surface-baseline.json
git commit -m "feat(tauri): expose provider and voice route commands"
```

### Task 5: Replace The Services Shell With The Real Configuration UI

**Files:**
- Create: `src/features/services/provider-editor.tsx`
- Create: `src/features/services/voice-route-editor.tsx`
- Create: `src/features/services/services-state.ts`
- Modify: `src/screens/services/services-page.tsx`
- Modify: `src/screens/services/services-page.test.tsx`
- Modify: `src/styles/shell.css`
- Test: `src/features/services/services-state.test.ts`
- Test: `src/screens/services/services-page.test.tsx`

**Interfaces:**
- Consumes only wrappers in `src/api/commands.ts`.
- Renders provider cards/editor, masked key status/replacement, model discovery/test/activation, and cascaded/E2E route editor/test/activation.

- [ ] **Step 1: Write failing reducer and UI tests**

Test loading/error/empty states, provider create/edit/delete/activate, blank key preservation, key field cleared after submission, model choices, mode-specific route fields, route test gating activation, one active badge, accessible controls, and sanitized errors. Mock only the adapter boundary; assert no `fetch`, `/api/`, secret echo, login, or management-server copy.

- [ ] **Step 2: Verify RED**

Run: `npm run test:tauri-ui -- src/features/services src/screens/services/services-page.test.tsx`

Expected: FAIL because real Services features do not exist.

- [ ] **Step 3: Implement state and focused editors**

Use controlled forms; keep the key only in password input until submission and clear it in `finally`. Reload public config after each mutation. Disable destructive/activation actions in flight and show field errors without raw provider errors.

- [ ] **Step 4: Compose the page and styles**

Keep heading/navigation semantics. Use native controls/buttons, responsive cards, visible focus, and status text; add no UI dependency.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:tauri-ui -- src/features/services src/screens/services/services-page.test.tsx`

Run: `npm run build:tauri-ui`

Expected: tests and build PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/features/services src/screens/services src/styles/shell.css
git commit -m "feat(tauri-ui): configure providers and voice routes"
```

### Task 6: Phase 3 Acceptance And Durable Handoff

**Files:**
- Create: `docs/migration/phase-03-services-acceptance.md`
- Modify if verified: `tests/tauri/security-surface-baseline.json`

- [ ] **Step 1: Run the full gates**

```powershell
npm run test:tauri
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo audit --file src-tauri/Cargo.lock
npm audit
npm run test:desktop-shell
npm run build
git diff --check
git status --short --branch
```

Expected: every command exits 0; only `.codex-tmp/` and `videos/` remain untracked.

- [ ] **Step 2: Perform bounded Windows credential smoke**

Run the ignored round-trip explicitly with its generated test-only reference; verify set/read/overwrite/delete and no leftover credential.

- [ ] **Step 3: Inspect security boundaries**

Search tracked files for submitted secret markers, generic Tauri fs/shell grants, `/api/` in the Tauri SPA, and management origins. Expected: no Phase 3 violation.

- [ ] **Step 4: Write acceptance evidence**

Record Qoder's completed foundation, completed commit range, dependency/license choice, exact test results, UI path, and explicit deferrals: role/LiveKit/storage settings, vectors/chunks, audio runtime, legacy deletion, deployment, and real paid-provider smoke requiring user credentials.

- [ ] **Step 5: Commit**

```powershell
git add -f docs/migration/phase-03-services-acceptance.md
git commit -m "docs: accept Tauri services configuration phase"
```

## Self-Review

- Spec coverage: provider configuration, model discovery/test, voice routes, Credential Manager lifecycle, centralized IPC, least privilege, Services UI, redaction, atomic persistence, and acceptance map to Tasks 1-6.
- Approved-scope note: role, LiveKit, and storage settings are in the broad design's Phase 3 line but were explicitly excluded from the approved first Phase 3 slice and are deferred.
- Placeholder scan: no TBD/TODO or unspecified error-handling step remains.
- Type consistency: Rust DTOs are exported through ts-rs and consumed only by `src/api/commands.ts`.

