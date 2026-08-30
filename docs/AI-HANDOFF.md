# Go Control API AI Handoff

> **Historical snapshot (2026-08-15).** Do not treat paths, worktrees, or “next
> tasks” below as current. Agent ledgers under `.superpowers/` and
> `docs/superpowers/` are local-only (gitignored). For today’s behavior see:
>
> - [server/control-api/README.md](../server/control-api/README.md)
> - [server/management-web/README.md](../server/management-web/README.md)
> - [docs/windows-client.md](windows-client.md)
> - [docs/dependency-decisions.md](dependency-decisions.md) (top entries = current)

Last updated as a living handoff: 2026-08-15 (Asia/Shanghai). Archived below.

## Resume location

- Repository: `E:\CodexAI\AI-powered`
- Worktree: `E:\CodexAI\AI-powered\.worktrees\go-control-api-auth`
- Branch: `codex/go-control-api-auth`
- Current commit: `b5610651d380367911f09a2210200afb1e9251ba`
- Main implementation plan: `docs/superpowers/plans/2026-08-14-go-control-api-auth.md`
- Approved architecture: `docs/superpowers/specs/2026-08-14-management-client-split-design.md`
- SDD ledger and reports: `.superpowers/sdd/2026-08-14-go-control-api-auth/`

Do not continue in the main worktree. Resume in the worktree and branch above.

## Product decisions already made

- The server-side management/control API is written in Go.
- The Windows client may later be rewritten in Rust; clients integrate through HTTP/OpenAPI, not Go-specific interfaces.
- There is login but no public registration.
- Only administrators can create users. No ordinary client user is seeded automatically.
- AI provider keys, RTC credentials/tokens, and other shared secrets must eventually move to the server; they must never be embedded in the browser/Electron client or committed.
- Browser sessions use secure cookies. Desktop sessions use purpose-bound bearer tokens. Session tokens are stored in PostgreSQL only as SHA-256 digests.

## Completed and reviewed

Tasks 1-5 are implemented and independently reviewed.

1. Go service/config/health/OpenAPI scaffold.
2. PostgreSQL identity migrations and isolated integration-test harness.
3. Argon2id password hashing and verification.
4. User/session/device/audit persistence with stable errors and transactional invariants.
5. One-time administrator CLI and identity service.

Important commits, newest last:

- `3b91f28`, `5e0147c`: service scaffold and contract fixes.
- `b2176f7`, `e2af6cf`: database schema and migration hardening.
- `00e0411`: Argon2id password service.
- `1b404c2`, `c62bad9`, `1ede28a`: persistence stores and migration consistency.
- `18f163d`, `51f459b`, `61930ca`: administrator CLI, transactional actor revalidation, and Goose PL/pgSQL migration fix.

Real PostgreSQL verification passed after `61930ca` for:

- migration up/down and repeat execution;
- audit-log immutability trigger;
- 32-byte session digest constraint;
- device foreign-key migration path;
- two-connection concurrent initial-admin bootstrap (exactly one succeeds).

The test schemas clean themselves up. No production user was created by these tests.

## Task 6 checkpoint

Commit `b561065` adds:

- `POST /api/v1/auth/login`;
- `POST /api/v1/auth/logout`;
- `GET /api/v1/auth/me`;
- strict 32 KiB JSON decoding and stable errors with request IDs;
- browser cookie and desktop bearer-token purpose isolation;
- authentication middleware;
- real/dummy Argon2 verification;
- transactional session/audit orchestration;
- in-process login rate limiting with trusted-proxy CIDR handling;
- OpenAPI cookie and bearer security schemes.

The implementer reported these passing without a database URL:

```powershell
Set-Location E:\CodexAI\AI-powered\.worktrees\go-control-api-auth\server\control-api
E:\CodexAI\AI-powered\.worktrees\go-control-api-auth\.tools\go1.26.5\go\bin\go.exe test ./...
E:\CodexAI\AI-powered\.worktrees\go-control-api-auth\.tools\go1.26.5\go\bin\go.exe vet ./...
```

### Open Task 6 defect

Task 6 is committed but is **not accepted as complete**. It has not received an independent code review, and the real PostgreSQL HTTP integration test fails:

```text
TestDatabaseAuthenticationPostgresLoginAndLogoutAreAtomic
auth_test.go:395: authentication service unavailable
```

All preceding HTTP unit tests passed in that run. The database migrated successfully to version 2 before the authentication service failure.

Next AI must use systematic debugging and TDD:

1. Reproduce only `TestDatabaseAuthenticationPostgresLoginAndLogoutAreAtomic` with `TEST_DATABASE_URL` supplied through a temporary process environment variable. Never place the URL/password in shell history, source, reports, or Git.
2. Trace the returned `ErrAuthenticationService` to the exact pgx/store operation. Do not expose the underlying database error in HTTP responses, but add safe test diagnostics if needed.
3. Write or preserve a failing regression test before changing production code.
4. Apply the smallest root-cause fix.
5. Rerun the focused live test, `go test ./...`, `go vet ./...`, and then request an independent review of Task 6.

Do not claim Task 6 complete until the live test and independent review pass.

## Remaining planned work

After Task 6 is accepted:

1. Task 7: administrator user-management API (list/create/status/reset/revoke), browser-admin authorization, last-active-admin protection, stable errors, audit and OpenAPI.
2. Task 8: non-root container, loopback-only local Compose, environment example, operations/security/license docs, smoke test, and complete client/server regression checks.
3. Whole-branch independent review and one bounded fix wave.
4. Finish/merge the branch using the `finishing-a-development-branch` workflow.

Only after the completion gate, create separate plans for:

1. Next.js management UI login and user administration.
2. Central AI configuration and inference proxy.
3. Central RTC configuration and token issuance.
4. Electron/Rust client login, secure token storage, configuration pull, device heartbeat, and forced logout.
5. Candidate-record upload only after a separate privacy/retention design.

## Environment and verification notes

- Portable Go currently used: `.tools/go1.26.5/go/bin/go.exe` (not committed).
- Upgrade to the documented security-fixed Go 1.26.6 before production deployment, then rerun tests and vulnerability scanning.
- Windows `-race` cannot run until CGO and a C compiler such as GCC are installed.
- Docker was unavailable during earlier work; Task 8 container checks remain unrun.
- One pre-existing high-severity npm audit advisory existed before this branch.
- The login limiter is process-local. Multi-replica production requires ingress/shared limiting.

## Security rules for continuation

- Never commit or print PostgreSQL URLs/passwords, API keys, RTC secrets, session tokens, password hashes, audit exports, or candidate information.
- Do not copy credentials from chat/screenshots into `.env`, reports, tests, commands that echo arguments, or source files.
- Keep PostgreSQL integration tests isolated in random schemas and ensure cleanup.
- Do not weaken stable public errors to expose raw pgx, Argon2, or internal errors.
- Follow `AGENTS.md`: research official/open-source capabilities before new dependencies and record decisions in `docs/dependency-decisions.md`.

## Useful entry files

- `server/control-api/internal/httpapi/auth.go`
- `server/control-api/internal/httpapi/auth_test.go`
- `server/control-api/internal/httpapi/router.go`
- `server/control-api/internal/ratelimit/login.go`
- `server/control-api/internal/identity/service.go`
- `server/control-api/internal/sessions/store.go`
- `server/control-api/internal/users/store.go`
- `server/control-api/internal/database/database.go`
- `server/control-api/openapi/openapi.yaml`
- `.superpowers/sdd/2026-08-14-go-control-api-auth/task-6-report.md`

