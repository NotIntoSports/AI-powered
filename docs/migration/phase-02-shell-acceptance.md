# Phase 2 — React Page Shell Acceptance

**Decision**: PASS  
**Date**: 2026-09-05  
**Commit range**: 4a578f6..4e537bb (Task 1–7, 7 commits on main)  
**Baseline**: 1bc6bfb (Phase 0–1 acceptance)

## Checklist

- [x] 5 page shells render with sidebar navigation (workspace/materials/records/services/settings)
- [x] Page shells have zero business command calls (no @tauri-apps/api import)
- [x] Page shells have zero old-path dependencies (no next/app/features/lib import)
- [x] Page shells have zero network calls (no fetch)
- [x] Page shells have zero polling (no setInterval)
- [x] Repair mode still takes priority over page shell rendering
- [x] Legacy Electron/Next path: 183 desktop-shell tests PASS + Next build PASS
- [x] capability/CSP/bindings/security_contract: zero drift since 1bc6bfb
- [x] `test:tauri` now includes vitest (React component tests no longer silently skipped)
- [x] `dist-tauri-ui` does not contain vendor/ dead assets (publicDir:false effective)
- [x] Dependency decision ledger records wouter selection (local docs/dependency-decisions.md)
- [x] No login/logout concepts leaked into the shell layer

## Command Evidence

All timestamps use Asia/Shanghai (`+08:00`).

| Command | Exit Code | Notes |
|---------|-----------|-------|
| `npm run test:tauri` | 1 (known non-blocking) | cargo test: 26 passed, 1 ignored; 2 security integration tests passed. vitest: 72 passed (12 files). node --test contracts: 20/21 passed (1 fail: rg ENOENT). `build:tauri-ui` not reached in chain; verified separately below. |
| `npm run build:tauri-ui` | 0 | tsc + vite build: 35 modules, 197 kB JS (63 kB gzip), 2.64 kB CSS. Vite 8 native config loader warning in stderr. |
| `npm run test:desktop-shell` | 0 | 183 passed, 0 failed, duration 3887 ms |
| `npm run build` | 0 | Next 15.5.22 production build: 23 static pages generated. `.agents/skills/hyperframes` traced-file ENOENT warning (known). |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | 0 | No warnings |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | 0 | No formatting drift |
| `git diff --check` | 0 | No whitespace errors in working tree |
| `npm audit --audit-level=high` | 0 | 0 vulnerabilities |
| `node --test tests/tauri/page-shell-contract.test.mjs` | 0 | 10 tests, 10 pass, 0 fail, duration 211 ms |

## Boundary Audit

`node --test tests/tauri/page-shell-contract.test.mjs` — 10 assertions, all PASS:

| Assertion | Result |
|-----------|--------|
| page shell does not directly import Tauri API | PASS |
| page shell does not call fetch | PASS |
| page shell does not reference old API routes | PASS |
| page shell does not import Next.js modules | PASS |
| page shell does not use target=_blank | PASS |
| page shell does not contain login/logout concepts | PASS |
| page shell does not use polling patterns | PASS |
| security surface has zero drift since Phase 0-1 acceptance | PASS |
| route ids match the design spec | PASS |
| app.tsx retains startup dispatch structure | PASS |

## Known Non-Blocking Issues

1. `tests/tauri/frontend-contract.test.mjs` "only the command adapter imports the low-level Tauri invoke API" test fails locally with `spawnSync rg ENOENT` — ripgrep not in PATH on this Windows environment. Passes in CI (GitHub Actions has rg pre-installed). Not a regression. This causes `npm run test:tauri` to exit 1 locally; `build:tauri-ui` was verified separately.
2. Vite 8 native config loader warning in stderr (`vite.config.ts` ESM syntax loaded as CommonJS).
3. Next build `.agents/skills/hyperframes` traced-file ENOENT warning (broken symlink in workspace).
4. CI gate (`ci.yml:17-26`) rejects tracked `docs/` files — push would fail. Pre-existing from Phase 0–1. Must be resolved before any push.

## Deferred to Future Phases

- Windows release `http://tauri.localhost` navigation allowlist fix (`lib.rs:12-21`) → Phase 3 prerequisite
- Contract generation registry refactor (`contracts.rs` positional format!) → Phase 3
- Capability check from exact array to structural invariants → Phase 3 (first new command)
- Bundle budget gate + vendor chunking → Phase 3 (when pages have real content)
- Versioned event seam + external store → Phase 5 (high-frequency data)
- CI docs gate resolution → before first push

## Scope Statement

This acceptance authorizes beginning Phase 3 (provider & voice-route configuration) planning only. It does NOT authorize deleting or changing the default Electron/Next.js product path.
