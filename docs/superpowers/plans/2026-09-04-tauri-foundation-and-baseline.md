# Tauri Foundation and Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a measured legacy baseline and a parallel, packaged Tauri 2 foundation with typed IPC, versioned local configuration, Windows Credential Manager secrets, SQLite migrations, diagnostics, and configuration repair mode without changing the default Electron product path.

**Architecture:** Add a Vite/React SPA under `src/` and a Rust/Tauri application under `src-tauri/` while leaving the existing Next.js/Electron runtime untouched. Rust owns configuration, secrets, SQLite, diagnostics, and IPC contracts; TypeScript consumes generated DTOs through one command wrapper. This plan implements design phases 0 and 1 only.

**Tech Stack:** Tauri 2, Rust 1.96, React 19, TypeScript 5.8, Vite 8, `serde`, `serde_json`, `thiserror`, `keyring`, `rusqlite`, `ts-rs`, Node test runner, Cargo test.

**Spec:** `docs/superpowers/specs/2026-09-04-tauri-local-monolith-design.md`

## Global Constraints

- Work directly on `main`; do not create a branch or worktree unless the user explicitly changes this instruction.
- Windows 10 22H2 and Windows 11 x64 are the only target platforms in this plan.
- Keep `npm run dev`, `npm run build`, Electron packaging, and existing tests operational throughout this plan.
- The new Tauri entry is opt-in through `npm run tauri:dev` and `npm run tauri:build` until a later migration plan changes the default.
- React must not read files, SQLite, persistent secrets, environment variables, or spawn processes.
- Rust DTOs are the source of truth; `src/generated/bindings.ts` is generated and must not be edited manually.
- Production secrets are stored only in Windows Credential Manager; tests use an in-memory secret store.
- Do not add login, users, remote management APIs, author-controlled servers, telemetry, or a Node sidecar.
- No new dependency is installed before its stable version, license, maintenance, Windows support, size, security posture, data flow, and maintenance cost are recorded in `docs/dependency-decisions.md`.
- Never stage `.codex-tmp/`, `videos/`, real configuration, database files, logs, credentials, or generated user data.
- Every task ends with its focused tests and a commit. Do not combine task commits.

## Plan Scope and Follow-on Plans

This plan produces the foundation only. The following separate plans are required after it passes:

1. React page-shell migration;
2. provider and voice-route configuration;
3. SQLite materials, FTS5, sqlite-vec, and document parsing;
4. direct Rust runtime and cascaded speech;
5. OBS, Windows integration, and AudioBridge sidecar;
6. Realtime and optional LiveKit;
7. legacy import, server retirement, and public cutover.

## Target File Map

```text
package.json                              Tauri/Vite scripts and frontend packages
package-lock.json                         exact npm dependency lock
index.html                                Vite SPA entry
vite.config.ts                            Tauri development/build configuration
tsconfig.tauri.json                       isolated SPA TypeScript project
src/main.tsx                              React bootstrap
src/app/app.tsx                           foundation/repair-mode shell
src/api/commands.ts                       only frontend invoke wrapper
src/generated/bindings.ts                 generated Rust DTOs
src/styles/foundation.css                 minimal foundation UI
src-tauri/Cargo.toml                      Rust dependency manifest
src-tauri/Cargo.lock                      exact Rust dependency lock
src-tauri/build.rs                        Tauri build hook
src-tauri/tauri.conf.json                 desktop and bundle configuration
src-tauri/capabilities/main.json           least-privilege main-window capability
src-tauri/migrations/0001_foundation.sql  initial local schema
src-tauri/src/main.rs                     binary entry only
src-tauri/src/lib.rs                      app composition and command registration
src-tauri/src/app_state.rs                shared application services
src-tauri/src/error.rs                    stable public error contract
src-tauri/src/contracts.rs                Rust DTOs exported to TypeScript
src-tauri/src/commands.rs                 thin Tauri commands
src-tauri/src/config/mod.rs               config domain types
src-tauri/src/config/locator.rs           deterministic config path selection
src-tauri/src/config/store.rs             validation, migration, atomic persistence
src-tauri/src/secrets/mod.rs              secret-store trait and service
src-tauri/src/secrets/memory.rs           deterministic test implementation
src-tauri/src/secrets/windows.rs          Windows Credential Manager implementation
src-tauri/src/database/mod.rs             SQLite connection and migration runner
src-tauri/src/diagnostics/mod.rs           bounded redacted diagnostic writer
scripts/measure-desktop-baseline.ps1       reproducible legacy measurements
scripts/test-tauri-package.mjs             packaged Tauri smoke check
tests/tauri/frontend-contract.test.mjs     static frontend boundary checks
docs/migration/current-capability-inventory.md  legacy capability inventory
docs/migration/baseline-results.md         measured baseline and environment
```

### Task 1: Capture the Legacy Capability and Resource Baseline

**Files:**
- Create: `scripts/measure-desktop-baseline.ps1`
- Create: `tests/tauri/baseline-script.test.mjs`
- Create: `docs/migration/current-capability-inventory.md`
- Create: `docs/migration/baseline-results.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `package.json`, `electron-builder.yml`, `app/`, `desktop/`, `server/management-web/`, `server/control-api/`, and `server/livekit-agent/`.
- Produces: `npm run measure:legacy`, which writes one JSON measurement to stdout and accepts `-OutputPath`; a reviewed capability inventory; a baseline results template populated with the current toolchain and repository commit.

- [x] **Step 1: Write the failing behavioral contract test**

Create `tests/tauri/baseline-script.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("legacy baseline script emits bounded machine-readable metrics", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-baseline-"));
  const outputPath = path.join(directory, "baseline.json");
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.resolve("scripts/measure-desktop-baseline.ps1"),
      "-OutputPath", outputPath,
    ], { cwd: path.resolve("."), encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const stdout = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
    const persisted = JSON.parse((await readFile(outputPath, "utf8")).replace(/^\uFEFF/, ""));
    assert.deepEqual(persisted, stdout);
    assert.deepEqual(Object.keys(stdout), [
      "commit", "measuredAt", "installerBytes", "runtimeBytes", "startupMs",
      "idleWorkingSetBytes", "idleCpuPercent",
    ]);
    assert.match(stdout.commit, /^[0-9a-f]{40}$/);
    assert.ok(Number.isFinite(Date.parse(stdout.measuredAt)));
    for (const field of ["installerBytes", "runtimeBytes", "startupMs", "idleWorkingSetBytes", "idleCpuPercent"]) {
      assert.equal(stdout[field], null);
    }
    assert.doesNotMatch(result.stdout, /API[_-]?KEY|PASSWORD|TOKEN/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run the test and verify the missing script fails**

Run: `node --test tests/tauri/baseline-script.test.mjs`

Expected: FAIL because PowerShell exits non-zero while `scripts/measure-desktop-baseline.ps1` is missing.

- [x] **Step 3: Implement the measurement script**

Create a PowerShell script with parameters `ExecutablePath`, `InstallerPath`, `RuntimePath`, `WarmupSeconds = 8`, `SampleSeconds = 10`, and `OutputPath`. It must:

1. resolve only caller-supplied paths;
2. record `git rev-parse HEAD`;
3. measure installer and runtime directory bytes when present;
4. start the executable hidden only when supplied;
5. wait for warmup, sample process-tree working set and CPU, then stop only the process it started;
6. emit this exact shape:

```powershell
$measurement = [ordered]@{
  commit = $commit
  measuredAt = [DateTimeOffset]::UtcNow.ToString('o')
  installerBytes = $installerBytes
  runtimeBytes = $runtimeBytes
  startupMs = $startupMs
  idleWorkingSetBytes = $idleWorkingSetBytes
  idleCpuPercent = $idleCpuPercent
}
$json = $measurement | ConvertTo-Json -Depth 3
if ($OutputPath) { Set-Content -LiteralPath $OutputPath -Value $json -Encoding utf8 }
$json
```

Use `try/finally` and `Stop-Process -Id $startedProcess.Id` only. Never search for or terminate processes by broad name.

- [x] **Step 4: Write the inventory and baseline documents**

Inventory every current management page, client page, Control API domain, Python Agent mode, Electron IPC group, AudioBridge command, local database table, packaging resource, and deployment service. For each row record `keep`, `migrate`, or `delete`, with its destination design section.

Populate `baseline-results.md` with:

```markdown
# Legacy Desktop Baseline

- Commit: value emitted by `git rev-parse HEAD` during measurement
- Measured at: UTC ISO-8601 value emitted by the measurement script
- OS: `OsName` and `OsVersion` emitted by `Get-ComputerInfo`
- Toolchain: Rust 1.96.0; Node 24.14.0; .NET 10.0.303; Go 1.26.2; Python 3.12.10
- Measurement command: `npm run measure:legacy -- -ExecutablePath dist/win-unpacked/AI-Virtual-Assistant.exe -InstallerPath dist/AI-Virtual-Assistant-0.1.0-Windows-x64.exe -RuntimePath dist/win-unpacked -OutputPath docs/migration/legacy-baseline.json`

| Metric | Value | Status |
| --- | ---: | --- |
| Installer bytes | measured value or `not-built` | evidence only |
| Runtime bytes | measured value or `not-built` | evidence only |
| Startup milliseconds | measured value or `not-run` | evidence only |
| Idle working set bytes | measured value or `not-run` | evidence only |
| Idle CPU percent | measured value or `not-run` | evidence only |
```

Do not invent missing measurements. Record `not-built` or `not-run` with the reason.

- [x] **Step 5: Add the package script and run verification**

Add:

```json
"measure:legacy": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/measure-desktop-baseline.ps1"
```

Run:

```powershell
node --test tests/tauri/baseline-script.test.mjs
npm run measure:legacy
```

Expected: test PASS; measurement exits 0 and emits valid JSON even when no executable is supplied.

- [x] **Step 6: Commit the baseline**

```powershell
git add package.json scripts/measure-desktop-baseline.ps1 tests/tauri/baseline-script.test.mjs
git add -f docs/migration/current-capability-inventory.md docs/migration/baseline-results.md
git commit -m "docs: capture desktop migration baseline"
```

### Task 2: Record and Lock Foundation Dependencies

**Files:**
- Modify: `docs/dependency-decisions.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/Cargo.lock`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/icons/app-icon.svg`
- Create: `src-tauri/icons/icon.ico`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/main.rs`
- Create: `tests/tauri/dependency-contract.test.mjs`

**Interfaces:**
- Consumes: approved dependency choices in spec section 25.
- Produces: exact npm and Cargo locks for the foundation; no application behavior.

- [x] **Step 1: Write the dependency contract test**

The test must parse `package.json` and `src-tauri/Cargo.toml` and assert:

```js
assert.equal(pkg.dependencies["@tauri-apps/api"], "2.11.1");
assert.equal(pkg.devDependencies["@tauri-apps/cli"], "2.11.4");
assert.equal(pkg.devDependencies.vite, "8.2.2");
assert.equal(pkg.dependencies.react, "19.2.8");
assert.match(cargo, /tauri\s*=\s*\{\s*version\s*=\s*"=?2/);
assert.match(cargo, /keyring/);
assert.match(cargo, /rusqlite/);
assert.match(cargo, /ts-rs/);
```

- [x] **Step 2: Verify the test fails before manifests exist**

Run: `node --test tests/tauri/dependency-contract.test.mjs`

Expected: FAIL because `src-tauri/Cargo.toml` does not exist.

- [x] **Step 3: Complete the dependency investigation record**

In `docs/dependency-decisions.md`, record the exact selected versions after querying npm/crates.io and official repositories. Include license, last release/commit, unresolved Windows issue summary, Windows/WebView2 compatibility, installed size measured from lock/install output, runtime cost, security/data flow, integration effort, and rejected alternatives for:

- Tauri and official plugins;
- Vite and React;
- `serde`, `thiserror`, `keyring`, `rusqlite`, and `ts-rs`.

Run `npm audit --omit=dev`, `npm audit`, `cargo tree`, and `cargo audit` if installed. If `cargo audit` is unavailable, record that fact and check the RustSec advisory database through its official tooling instructions before accepting the lock.

- [x] **Step 4: Install exact frontend packages without replacing legacy scripts**

Run:

```powershell
npm install --save-exact @tauri-apps/api@2.11.1 react@19.2.8 react-dom@19.2.8
npm install --save-dev --save-exact @tauri-apps/cli@2.11.4 vite@8.2.2 @vitejs/plugin-react@6.1.1 vitest@5.0.0 @testing-library/react@16.3.3 @testing-library/jest-dom@7.0.1 jsdom@29.0.0
```

`jsdom` is pinned to 29.0.0 because 30.0.1 requires Node 24.15 or newer while the measured legacy baseline uses Node 24.14.0.

Keep existing Next.js and Electron packages until their later deletion gates.

- [x] **Step 5: Create the Rust manifest and build hook**

Create a package named `ai-virtual-assistant-desktop`, edition 2024, `rust-version = "1.96"`, library crate types `staticlib`, `cdylib`, and `rlib`, plus a minimal binary calling a placeholder library `run` function so this task's `cargo check` has real targets. Task 3 replaces the placeholder with Tauri composition. Use exact versions resolved by `cargo add` for:

```text
tauri, serde, serde_json, thiserror, keyring, rusqlite, ts-rs,
uuid, chrono, tracing, tracing-subscriber, tempfile
```

Enable `rusqlite` bundled SQLite and required Tauri features only. Generate and commit `Cargo.lock`.

`build.rs` contains only:

```rust
fn main() {
    tauri_build::build()
}
```

Also create the minimal valid `tauri.conf.json` required by `tauri-build`; Task 3 extends it with the Vite URL, frontend output, and window configuration. Add a repository-owned SVG icon source and use the official Tauri CLI icon generator to produce the Windows `.ico` required by `tauri-build`.

- [x] **Step 6: Run dependency and legacy regression checks**

Run:

```powershell
node --test tests/tauri/dependency-contract.test.mjs
npm audit
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

Expected: contract PASS, no unaccepted audit finding, Cargo check PASS, legacy Next build PASS.

- [x] **Step 7: Commit locked dependencies**

```powershell
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs tests/tauri/dependency-contract.test.mjs
git commit -m "build: lock Tauri foundation dependencies"
```

`docs/dependency-decisions.md` is intentionally ignored by this repository and remains a local investigation ledger; do not force-add it.

### Task 3: Create the Parallel Tauri and Vite Shell

**Files:**
- Create: `index.html`
- Create: `vite.config.ts`
- Create: `tsconfig.tauri.json`
- Create: `src/main.tsx`
- Create: `src/app/app.tsx`
- Create: `src/styles/foundation.css`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/main.json`
- Modify: `package.json`
- Create: `tests/tauri/shell-contract.test.mjs`

**Interfaces:**
- Consumes: Task 2 manifests.
- Produces: `npm run tauri:dev`, `npm run tauri:build`, and a static React shell displaying `Tauri Foundation`.

- [x] **Step 1: Write the failing shell contract test**

Assert that Vite output is `dist-tauri-ui`, Tauri `frontendDist` is `../dist-tauri-ui`, `devUrl` is `http://127.0.0.1:1420`, the Tauri identifier is `com.aivirtualassistant.desktop`, and the new package scripts do not modify existing `dev`, `build`, `build:desktop`, or `make:windows` values.

- [x] **Step 2: Run the test and confirm missing files fail**

Run: `node --test tests/tauri/shell-contract.test.mjs`

Expected: FAIL with missing `vite.config.ts` or `tauri.conf.json`.

- [x] **Step 3: Implement the isolated Vite SPA**

Use a fixed development host/port and no environment variables exposed to the SPA:

```ts
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["TAURI_ENV_"],
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { outDir: "dist-tauri-ui", emptyOutDir: true, target: "chrome105" }
});
```

The initial app renders a heading, current foundation status text, and no legacy iframe or remote URL.

- [x] **Step 4: Implement the minimum Tauri application**

`main.rs` calls `ai_virtual_assistant_desktop::run()`. `lib.rs` builds one window, prevents remote navigation, and contains no commands yet. Configure CSP with local scripts/styles/assets and `connect-src 'self' ipc: http://ipc.localhost`; do not allow arbitrary `http:` or `https:` in the foundation shell.

- [x] **Step 5: Add opt-in scripts**

```json
"dev:tauri-ui": "vite --config vite.config.ts",
"build:tauri-ui": "tsc -p tsconfig.tauri.json && vite build --config vite.config.ts",
"test:tauri-ui": "vitest run --config vite.config.ts",
"tauri:dev": "tauri dev",
"tauri:build": "tauri build"
```

- [x] **Step 6: Verify both new and legacy builds**

Run:

```powershell
node --test tests/tauri/shell-contract.test.mjs
npm run build:tauri-ui
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

Expected: all commands PASS; `dist-tauri-ui/index.html` exists; legacy `.next` build still succeeds.

- [x] **Step 7: Commit the parallel shell**

```powershell
git add index.html vite.config.ts tsconfig.tauri.json src src-tauri package.json tests/tauri/shell-contract.test.mjs
git commit -m "feat: add parallel Tauri desktop shell"
```

### Task 4: Define Stable Errors and Generate TypeScript Contracts

**Files:**
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/contracts.rs`
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/api/commands.ts`
- Create: `src/generated/bindings.ts`
- Create: `tests/tauri/frontend-contract.test.mjs`

**Interfaces:**
- Produces: `PublicError`, `CommandResult<T>`, `FoundationStatus`, command `foundation_get_status`, generated TypeScript DTOs, and `getFoundationStatus()`.

- [x] **Step 1: Write failing Rust and frontend contract tests**

Rust tests assert serialization shapes:

```rust
assert_eq!(serde_json::to_value(CommandResult::Ok { data: FoundationStatus { ready: true } }).unwrap(), json!({"ok":true,"data":{"ready":true}}));
assert_eq!(PublicError::new("CONFIG_INVALID", "配置无效", false).code, "CONFIG_INVALID");
```

The Node test asserts `src/generated/bindings.ts` starts with `// Generated by ts-rs. Do not edit.` and that only `src/api/commands.ts` imports `@tauri-apps/api/core`.

- [x] **Step 2: Run tests and verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml contracts
node --test tests/tauri/frontend-contract.test.mjs
```

Expected: Rust compile failure and missing generated binding failure.

- [x] **Step 3: Implement contracts and thin command**

Define tagged `CommandResult<T>` with `Ok { data }` and `Err { error }`, camelCase serialization, `request_id`, optional `field`, and `retryable`. `foundation_get_status` returns `{ ready: true }` through the result wrapper.

Derive `serde::Serialize`, `serde::Deserialize` where needed, and `ts_rs::TS` for public DTOs. Never derive/export internal config or secret types.

- [x] **Step 4: Generate bindings through a deterministic test**

Add a Rust test named `export_bindings` that writes all public DTOs to `../src/generated/bindings.ts` with the fixed header. Run it from the repository root and fail if unsupported Serde annotations are encountered.

- [x] **Step 5: Implement the only frontend invoke wrapper**

```ts
import { invoke } from "@tauri-apps/api/core";
import type { CommandResult, FoundationStatus } from "../generated/bindings";

export function getFoundationStatus() {
  return invoke<CommandResult<FoundationStatus>>("foundation_get_status");
}
```

- [x] **Step 6: Verify contract generation and drift check**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
git diff --exit-code -- src/generated/bindings.ts
node --test tests/tauri/frontend-contract.test.mjs
npm run build:tauri-ui
```

Expected: all PASS and no generated binding diff after a second generation.

- [x] **Step 7: Commit typed IPC**

```powershell
git add src src-tauri tests/tauri/frontend-contract.test.mjs
git commit -m "feat: add typed Tauri IPC contracts"
```

### Task 5: Implement Versioned Configuration Location and Validation

**Files:**
- Create: `config/local.example.json`
- Create: `src-tauri/src/config/mod.rs`
- Create: `src-tauri/src/config/locator.rs`
- Create: `src-tauri/src/config/store.rs`
- Create: `src-tauri/src/config/tests.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `AppConfigV1`, `PublicAppConfig`, `ConfigLocation`, `locate_config(args, env, dirs)`, `ConfigStore::load()`, and `ConfigStore::save_patch(ConfigPatch)`.

- [x] **Step 1: Write failing path-precedence tests**

Test exact precedence:

```text
--config absolute path
AI_VIRTUAL_ASSISTANT_CONFIG absolute path
development <repo>/config/local.json
release %APPDATA%/AI Virtual Assistant/config.json
```

Reject relative CLI/env paths with `CONFIG_PATH_NOT_ABSOLUTE`. Do not inspect arbitrary environment keys.

- [x] **Step 2: Write failing validation tests**

Test empty valid defaults, unknown `configVersion`, duplicate provider IDs, active references to missing IDs, invalid URL schemes, secrets embedded in JSON, and invalid log retention. Expected codes include `CONFIG_VERSION_UNSUPPORTED`, `CONFIG_DUPLICATE_ID`, `CONFIG_REFERENCE_MISSING`, `CONFIG_URL_INVALID`, `CONFIG_SECRET_INLINE_FORBIDDEN`, and `CONFIG_FIELD_INVALID`.

- [x] **Step 3: Run focused tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml config::`

Expected: compile failure because the config module is missing.

- [x] **Step 4: Implement typed V1 configuration**

The example file contains only non-sensitive fields and secret references. Provider secrets are represented as:

```rust
pub struct SecretSlot {
    pub reference: String,
    pub configured: bool,
}
```

Deserialization must use `deny_unknown_fields` for leaf records and explicit defaults for optional sections. URL validation accepts `http`/`https`, with `ws`/`wss` only for realtime/LiveKit endpoints. Release defaults contain no author-controlled IP or domain.

- [x] **Step 5: Implement atomic load/save and last-good recovery**

Write to a sibling temporary file, `sync_all`, rename, then retain one last-good copy after successful validation. On Windows rename collisions, close the source handle before replacement. Never overwrite the main file when validation fails.

- [x] **Step 6: Harden Git ignores**

Add exact patterns:

```gitignore
config/local.json
config/*.local.json
config/*.backup.json
config/*.tmp
```

Keep `config/local.example.json` tracked. Add a test that fails when any tracked file matches the secret-config patterns.

- [x] **Step 7: Verify and commit config foundation**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml config::
git ls-files config
git diff --check
```

Expected: tests PASS; only `config/local.example.json` is tracked in `config/`.

```powershell
git add .gitignore config/local.example.json src-tauri/src/config src-tauri/src/lib.rs
git commit -m "feat: add versioned local configuration"
```

### Task 6: Implement Windows Credential Manager Secrets

**Files:**
- Create: `src-tauri/src/secrets/mod.rs`
- Create: `src-tauri/src/secrets/memory.rs`
- Create: `src-tauri/src/secrets/windows.rs`
- Create: `src-tauri/src/secrets/tests.rs`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/contracts.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: trait `SecretStore`, `SecretService`, `MemorySecretStore`, `WindowsSecretStore`, and commands `secret_set`, `secret_delete`, `secret_status`.

- [x] **Step 1: Write failing secret lifecycle tests against memory storage**

Cover set, status, replace, delete, delete missing, provider deletion cleanup, and namespace isolation. Assert public results never contain the secret value.

- [x] **Step 2: Write a Windows ignored integration test**

Use a random entry under `com.aivirtualassistant.desktop.test/<uuid>`, write a random value, read internally, delete in `finally`, and assert status changes. Mark the test ignored by default and run it explicitly on Windows CI/release hosts.

- [x] **Step 3: Verify tests fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml secrets::`

Expected: compile failure because `SecretStore` is missing.

- [x] **Step 4: Implement the secret abstraction and Windows backend**

```rust
pub trait SecretStore: Send + Sync {
    fn set(&self, reference: &str, value: &str) -> Result<(), SecretError>;
    fn get(&self, reference: &str) -> Result<Option<Zeroizing<String>>, SecretError>;
    fn delete(&self, reference: &str) -> Result<bool, SecretError>;
    fn contains(&self, reference: &str) -> Result<bool, SecretError>;
}
```

Add `zeroize` only after recording its dependency decision. Validate references against `^[a-z0-9][a-z0-9/_-]{0,127}$`. Never log value length, contents, clipboard data, or credential backend debug output.

- [x] **Step 5: Implement public commands without secret readback**

`secret_set` accepts reference and new value, returns configured state. `secret_status` accepts references and returns booleans. There is no `secret_get` Tauri command.

- [x] **Step 6: Verify memory and Windows tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml secrets::
cargo test --manifest-path src-tauri/Cargo.toml windows_credential_round_trip -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all tests PASS; integration test removes its credential even when an assertion fails.

- [x] **Step 7: Commit secret storage**

```powershell
git add src-tauri/src src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: store provider secrets in Windows credentials"
```

Use the actual changed manifest paths; do not stage unrelated files.

### Task 7: Add SQLite Ownership and Explicit Migrations

**Files:**
- Create: `src-tauri/migrations/0001_foundation.sql`
- Create: `src-tauri/src/database/mod.rs`
- Create: `src-tauri/src/database/tests.rs`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `Database::open(path)`, `Database::migrate()`, `Database::integrity_check()`, and a single Rust-owned connection service.

- [ ] **Step 1: Write failing migration tests**

Use a temporary directory and verify:

- empty database migrates to schema version 1;
- repeated migration is idempotent;
- WAL, foreign keys, and 5000 ms busy timeout are enabled;
- unknown future migration version fails closed;
- integrity check returns `ok`;
- no table contains columns matching `api_key|token|secret|password`.

- [ ] **Step 2: Verify tests fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database::`

Expected: compile failure because `Database` is missing.

- [ ] **Step 3: Create the foundation migration**

Create only these tables in this plan:

```sql
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
CREATE TABLE app_preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE diagnostic_events(
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL,
  area TEXT NOT NULL,
  code TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
```

Do not prematurely create materials, vectors, sessions, or provider tables; their plans own those schemas.

- [ ] **Step 4: Implement explicit migration execution**

Use one transaction, record version only after successful SQL, and reject database versions newer than the binary. The database path is supplied by app-state initialization; the database module never locates directories itself.

- [ ] **Step 5: Run migration and full Cargo tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml database::
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all PASS.

- [ ] **Step 6: Commit database foundation**

```powershell
git add src-tauri/migrations src-tauri/src/database src-tauri/src/app_state.rs src-tauri/src/lib.rs
git commit -m "feat: add Rust-owned SQLite migrations"
```

### Task 8: Add Bounded Redacted Diagnostics

**Files:**
- Create: `src-tauri/src/diagnostics/mod.rs`
- Create: `src-tauri/src/diagnostics/tests.rs`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/contracts.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `DiagnosticEvent`, `DiagnosticWriter::record`, `DiagnosticWriter::export`, and command `diagnostics_export`.

- [ ] **Step 1: Write failing redaction and retention tests**

Test redaction for Bearer headers, API keys, tokens, secrets, passwords, URL user info, sensitive query keys, and JSON fields. Test message maximum 2000 characters, file maximum 5 MiB, retention 14 days, and no transcript/audio/document fields in exported events.

- [ ] **Step 2: Verify tests fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml diagnostics::`

Expected: compile failure because the diagnostics module is missing.

- [ ] **Step 3: Implement structured diagnostics**

Persist newline-delimited JSON with exact public fields:

```text
timestamp, level, area, code, requestId, sessionId?, snapshotId?, providerId?, durationMs?, retryCount?
```

Raw third-party bodies and arbitrary maps are not accepted by `record`. Rotate before exceeding the file limit. Cleanup operates only inside the resolved application logs directory.

- [ ] **Step 4: Implement safe export**

Export application/toolchain versions, public configuration, service status, and bounded diagnostic events to a user-selected path. Read public config through `ConfigStore`; never serialize internal config or SecretStore.

- [ ] **Step 5: Verify diagnostics and secret scans**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml diagnostics::
cargo test --manifest-path src-tauri/Cargo.toml
rg -n "Authorization|apiKey|api_key|accessToken|access_token|password" src-tauri/src/diagnostics
```

Expected: tests PASS; matches are limited to explicit redaction tests/rules, not logged fields.

- [ ] **Step 6: Commit diagnostics**

```powershell
git add src-tauri/src/diagnostics src-tauri/src/app_state.rs src-tauri/src/commands.rs src-tauri/src/contracts.rs src-tauri/src/lib.rs src/generated/bindings.ts
git commit -m "feat: add bounded local diagnostics"
```

### Task 9: Build Application State and Configuration Repair Mode

**Files:**
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/contracts.rs`
- Modify: `src/app/app.tsx`
- Create: `src/features/config-repair/config-repair.tsx`
- Create: `src/features/config-repair/config-repair.test.tsx`
- Modify: `src/api/commands.ts`
- Modify: `src/styles/foundation.css`

**Interfaces:**
- Produces: `StartupState::{Ready, Migrated, Recoverable, Invalid}`, commands `config_get_startup_state`, `config_restore_last_good`, `config_restore_defaults`, and a repair-mode screen.

- [ ] **Step 1: Write failing Rust startup-state tests**

Cover valid config, migrated config, malformed main with valid last-good, malformed both, unreadable config, database migration failure, and missing secret backend. Missing optional provider secrets must not block foundation startup.

- [ ] **Step 2: Write failing React repair-mode tests**

Mock only `src/api/commands.ts`. Verify field errors render, ready state renders foundation shell, recoverable state offers last-good restore, invalid state offers defaults/import/open-file, and no component imports Tauri core/plugins directly.

- [ ] **Step 3: Verify tests fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml startup_state
npm run test:tauri-ui -- src/features/config-repair/config-repair.test.tsx
```

Expected: missing state/command/component failures.

- [ ] **Step 4: Implement fail-closed app-state composition**

Initialize services in this order: directories, diagnostics, secret backend, config, database. Preserve structured failures and expose only public startup state. Do not panic for user-repairable configuration errors.

- [ ] **Step 5: Implement the repair UI**

The screen displays stable error code, field, localized message, and buttons for allowed commands. It must not display raw Rust errors, stack traces, configuration contents, or credential references.

- [ ] **Step 6: Verify Rust, frontend, and binding drift**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:tauri-ui -- src/features/config-repair/config-repair.test.tsx
node --test tests/tauri/frontend-contract.test.mjs
npm run build:tauri-ui
git diff --exit-code -- src/generated/bindings.ts
```

Expected: all PASS.

- [ ] **Step 7: Commit repair mode**

```powershell
git add src src-tauri
git commit -m "feat: add Tauri configuration repair mode"
```

### Task 10: Harden Tauri Capabilities and Window Behavior

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/main.json`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/security_contract.rs`
- Modify: `tests/tauri/shell-contract.test.mjs`

**Interfaces:**
- Produces: a single-instance, local-content-only window with explicitly enumerated commands and no generic shell/filesystem permission.

- [ ] **Step 1: Write failing security contract tests**

Assert:

- only window label `main` receives the capability;
- every allowed application command is enumerated;
- capability text lacks `shell:allow-execute`, `shell:allow-spawn`, broad fs scopes, remote URLs, and wildcard permissions;
- CSP lacks `unsafe-eval`, arbitrary `http:`, arbitrary `https:`, and remote scripts;
- navigation and new-window requests are denied unless they are local application content;
- application uses one-instance behavior.

- [ ] **Step 2: Run tests and verify current shell fails hardening checks**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test security_contract
node --test tests/tauri/shell-contract.test.mjs
```

Expected: FAIL on missing single-instance and incomplete command allowlist.

- [ ] **Step 3: Implement least privilege**

Use official Tauri capability entries for only the commands implemented in Tasks 4–9. Open config/data directories through a dedicated Rust command that resolves the fixed app directory and calls the OS opener; do not grant generic opener paths to the WebView.

Prevent navigation before commit, deny child WebViews/windows, and ensure development URLs are enabled only in debug builds.

- [ ] **Step 4: Verify security, Cargo, and frontend boundaries**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
node --test tests/tauri/*.test.mjs
npm run build:tauri-ui
```

Expected: all PASS.

- [ ] **Step 5: Commit hardening**

```powershell
git add src-tauri tests/tauri
git commit -m "security: constrain Tauri foundation capabilities"
```

### Task 11: Package and Smoke-Test the Foundation

**Files:**
- Create: `scripts/test-tauri-package.mjs`
- Create: `tests/tauri/package-contract.test.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/migration/baseline-results.md`

**Interfaces:**
- Produces: `npm run test:tauri-package` and evidence that the packaged Tauri foundation starts without Node, Go, Python, PostgreSQL, or Nginx.

- [ ] **Step 1: Write the failing package contract test**

Assert the smoke script checks:

- packaged executable exists;
- process starts and exposes a visible main window within 15 seconds;
- process tree contains no `node.exe`, `control-api`, `python.exe`, `postgres`, or `nginx` child;
- application can exit cleanly;
- no `.env`, `config/local.json`, database, log, or credential fixture exists inside the bundle.

- [ ] **Step 2: Verify the contract fails**

Run: `node --test tests/tauri/package-contract.test.mjs`

Expected: FAIL because `scripts/test-tauri-package.mjs` is missing.

- [ ] **Step 3: Implement package smoke without broad process termination**

Start the exact packaged executable, capture its PID, inspect only that process tree, communicate readiness through a test-only command or window enumeration, and terminate only the captured PID in `finally`. Redact all collected command lines before printing.

- [ ] **Step 4: Add scripts and documentation**

Add:

```json
"test:tauri": "cargo test --manifest-path src-tauri/Cargo.toml && node --test tests/tauri/*.test.mjs && npm run build:tauri-ui",
"test:tauri-package": "node scripts/test-tauri-package.mjs"
```

README labels Tauri as an experimental foundation and keeps Electron as the normal start path. Document Rust 1.96, Node 24, WebView2, `npm run tauri:dev`, and the absence of migrated product features.

- [ ] **Step 5: Build and smoke the package**

Run:

```powershell
npm run test:tauri
npm run tauri:build
npm run test:tauri-package
npm run test:desktop-shell
npm run build
```

Expected: all PASS. Tauri smoke reports no forbidden child process. Existing Electron tests and Next build remain green.

- [ ] **Step 6: Measure the Tauri foundation**

Run the baseline script against the Tauri executable/bundle and append a clearly labeled foundation comparison to `baseline-results.md`. Do not claim product-level performance because business features are not migrated.

- [ ] **Step 7: Commit packaging evidence**

```powershell
git add package.json scripts/test-tauri-package.mjs tests/tauri/package-contract.test.mjs README.md
git add -f docs/migration/baseline-results.md
git commit -m "test: verify packaged Tauri foundation"
```

### Task 12: Phase 0–1 Acceptance Gate

**Files:**
- Create: `docs/migration/phase-01-acceptance.md`
- Modify: `docs/migration/current-capability-inventory.md`
- Modify: `docs/dependency-decisions.md`

**Interfaces:**
- Consumes: all outputs and command evidence from Tasks 1–11.
- Produces: a binary pass/fail decision for starting the React page-shell migration plan.

- [ ] **Step 1: Run the complete fresh verification suite**

```powershell
npm run test:tauri
npm run tauri:build
npm run test:tauri-package
npm run test:desktop-shell
npm run build
npm audit
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
```

Record command, timestamp, exit code, and concise result. A skipped command makes the acceptance gate fail unless the document identifies a concrete unavailable external prerequisite and the feature is not required by this plan.

- [ ] **Step 2: Audit the architectural boundaries**

Run searches and record zero violations:

```powershell
rg -n "@tauri-apps/api|@tauri-apps/plugin" src --glob "!api/commands.ts"
rg -n "CONTROL_API_ORIGIN|control_api_token|http://175\.27\.132\.61" src src-tauri
rg -n "api[_-]?key|access[_-]?token|password|secret" config --glob "!local.example.json"
rg -n "shell:allow-(execute|spawn)|\*" src-tauri/capabilities
```

Expected: no boundary violation. Legitimate type/label matches must be documented line-by-line rather than ignored wholesale.

- [ ] **Step 3: Write the acceptance decision**

The document contains this checklist with evidence links/commands:

```markdown
- [ ] Legacy baseline captured without invented values
- [ ] Tauri package starts independently of Node server
- [ ] Existing Electron path remains operational
- [ ] Config precedence and fail-closed repair are tested
- [ ] Production secret round trip uses Windows Credential Manager
- [ ] SQLite migration and integrity tests pass
- [ ] Generated TypeScript contracts have no drift
- [ ] Diagnostics are bounded and redacted
- [ ] Tauri capability has no generic shell/filesystem access
- [ ] No author-controlled endpoint exists in new code
- [ ] Dependency decisions and locks are complete
```

Every item must be checked before declaring phases 0–1 accepted.

- [ ] **Step 4: Commit the acceptance record**

```powershell
git add -f docs/migration/phase-01-acceptance.md docs/migration/current-capability-inventory.md
git commit -m "docs: accept Tauri foundation phase"
```

Keep the updated `docs/dependency-decisions.md` as the repository's intentionally ignored local dependency ledger.

## Completion Condition

This plan is complete only when Task 12 is committed and its checklist is fully checked. Completion authorizes writing the React page-shell migration plan; it does not authorize deleting or changing the default Electron/Next.js product path.
