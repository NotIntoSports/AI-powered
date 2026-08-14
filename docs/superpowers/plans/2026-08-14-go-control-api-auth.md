# Go Control API Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deployable Go management API with PostgreSQL, a versioned OpenAPI contract, one-time administrator creation, password login, revocable sessions, and administrator-managed users.

**Architecture:** Add an isolated `server/control-api` Go module that exposes `/healthz` and `/api/v1` JSON endpoints. PostgreSQL owns users, sessions, devices, and audit records; random opaque session tokens are returned once and only SHA-256 digests are stored. The existing Electron/Next.js application is untouched in this phase and will consume the contract in a later plan.

**Tech Stack:** Go 1.26.5, `net/http`, chi v5.3.1 (MIT), pgx v5.10.0 (MIT), `golang.org/x/crypto` v0.54.0 (BSD-3-Clause), goose v3.27.3 (MIT), PostgreSQL 16+, OpenAPI 3.1, Docker Compose for local integration tests.

## Global Constraints

- Do not create any ordinary client user during bootstrap; only the administrator CLI may create the first `admin`.
- Do not expose public registration, password recovery, social login, OIDC, SAML, MFA, or multi-tenancy.
- Passwords use Argon2id with a unique random salt; passwords and session tokens never enter command-line arguments or logs.
- Browser sessions use `HttpOnly; Secure; SameSite=Strict` cookies; Electron sessions use `Authorization: Bearer` and are marked with a separate `purpose`.
- Store only SHA-256 session-token digests; logout, user disable, password reset, and explicit revoke must invalidate server-side sessions.
- All authenticated and authentication responses use `Cache-Control: no-store` and stable `{code,message,requestId}` errors.
- Candidate media, transcripts, interview records, AI credentials, RTC credentials, OBS, audio, and desktop behavior are out of scope for this plan.
- PostgreSQL and the API must not be exposed without TLS in production; local Compose binds PostgreSQL to loopback only.
- Record exact dependency versions, licenses, maintenance evidence, security notes, deployment size, and compatibility in `docs/dependency-decisions.md`.

---

## File Map

Create these focused units before adding later AI, RTC, or desktop work:

- `server/control-api/go.mod`: isolated Go dependency manifest.
- `server/control-api/cmd/control-api/main.go`: HTTP process entry point and graceful shutdown only.
- `server/control-api/cmd/control-api-admin/main.go`: interactive administrator bootstrap and password-reset CLI only.
- `server/control-api/internal/config/config.go`: environment parsing and validation.
- `server/control-api/internal/database/database.go`: pgx pool creation and embedded migration execution.
- `server/control-api/internal/database/migrations/*.sql`: schema history.
- `server/control-api/internal/password/password.go`: Argon2id encode and verify.
- `server/control-api/internal/users/store.go`: user persistence and status transitions.
- `server/control-api/internal/sessions/store.go`: opaque-token creation, lookup, revoke, and expiry.
- `server/control-api/internal/audit/store.go`: append-only audit persistence.
- `server/control-api/internal/httpapi/router.go`: route assembly and shared middleware.
- `server/control-api/internal/httpapi/json.go`: bounded JSON decoding and stable JSON responses.
- `server/control-api/internal/httpapi/auth.go`: login, logout, current-user handlers and authentication middleware.
- `server/control-api/internal/httpapi/admin_users.go`: administrator user-management handlers.
- `server/control-api/openapi/openapi.yaml`: language-neutral API contract.
- `server/control-api/Dockerfile`: non-root production image.
- `server/control-api/compose.yaml`: loopback-only local PostgreSQL and API.
- `server/control-api/README.md`: setup, migration, bootstrap, run, test, and recovery commands.

### Task 1: Lock Dependencies, Configuration, Health Endpoint, and OpenAPI Skeleton

**Files:**
- Create: `server/control-api/go.mod`
- Create: `server/control-api/internal/config/config.go`
- Create: `server/control-api/internal/config/config_test.go`
- Create: `server/control-api/internal/httpapi/router.go`
- Create: `server/control-api/internal/httpapi/router_test.go`
- Create: `server/control-api/cmd/control-api/main.go`
- Create: `server/control-api/openapi/openapi.yaml`
- Modify: `docs/dependency-decisions.md`

**Interfaces:**
- Produces: `config.Load(getenv func(string) string) (config.Config, error)`
- Produces: `httpapi.NewRouter(httpapi.Dependencies) http.Handler`
- Produces: `GET /healthz -> 200 {"service":"control-api","status":"ok"}`
- Produces: OpenAPI schemas `APIError`, `User`, `SessionResponse`, and `HealthResponse`.

- [ ] **Step 1: Add the dependency decision before introducing packages**

Append a dated section documenting Go 1.26.5, chi v5.3.1, pgx v5.10.0, x/crypto v0.54.0, and goose v3.27.3 with the licenses and selection rationale from the design. Explicitly reject Ory Kratos for this phase because registration, recovery, MFA, OIDC, and multi-tenancy are out of scope.

- [ ] **Step 2: Write failing configuration tests**

```go
func TestLoadRequiresDatabaseURL(t *testing.T) {
	_, err := Load(func(key string) string { return "" })
	if !errors.Is(err, ErrDatabaseURLRequired) { t.Fatalf("got %v", err) }
}

func TestLoadRejectsShortSessionTTL(t *testing.T) {
	env := map[string]string{"DATABASE_URL":"postgres://test", "SESSION_TTL":"5m"}
	_, err := Load(func(key string) string { return env[key] })
	if !errors.Is(err, ErrSessionTTLRange) { t.Fatalf("got %v", err) }
}
```

- [ ] **Step 3: Run the tests and verify the package is absent**

Run: `cd server/control-api; go test ./internal/config`

Expected: FAIL because `go.mod` and `config.Load` do not exist.

- [ ] **Step 4: Create the module and minimal validated configuration**

Use module path `github.com/ai-interviewer/ai-powered/control-api`, `go 1.26.5`, and pin:

```text
github.com/go-chi/chi/v5 v5.3.1
github.com/jackc/pgx/v5 v5.10.0
github.com/pressly/goose/v3 v3.27.3
golang.org/x/crypto v0.54.0
```

Implement:

```go
type Config struct {
	ListenAddress string
	DatabaseURL string
	SessionTTL time.Duration
	CookieSecure bool
}

func Load(getenv func(string) string) (Config, error)
```

Defaults: `ListenAddress=127.0.0.1:8080`, `SessionTTL=8h`, `CookieSecure=true`. Accept session TTL from 15 minutes through 30 days.

- [ ] **Step 5: Write the failing health-route test**

```go
func TestHealth(t *testing.T) {
	r := NewRouter(Dependencies{})
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK { t.Fatalf("status=%d", rec.Code) }
	if rec.Header().Get("Content-Type") != "application/json" { t.Fatal("missing JSON content type") }
}
```

- [ ] **Step 6: Implement the router, server lifecycle, and OpenAPI skeleton**

`NewRouter` uses chi request IDs, panic recovery, a 30-second request timeout, `X-Content-Type-Options: nosniff`, and JSON health output. `main.go` loads config, starts `http.Server`, handles SIGINT/SIGTERM, and allows 10 seconds for graceful shutdown. Define `/healthz`, `/api/v1/auth/*`, and `/api/v1/admin/users*` in OpenAPI even though protected handlers arrive in later tasks.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
Set-Location server/control-api
go mod tidy
go test ./internal/config ./internal/httpapi
go vet ./...
```

Expected: all commands PASS.

Commit:

```powershell
git add server/control-api docs/dependency-decisions.md
git commit -m "feat: scaffold Go control API"
```

### Task 2: PostgreSQL Schema, Embedded Migrations, and Test Database Harness

**Files:**
- Create: `server/control-api/internal/database/database.go`
- Create: `server/control-api/internal/database/database_test.go`
- Create: `server/control-api/internal/database/migrations/00001_identity.sql`
- Create: `server/control-api/internal/database/testdb_test.go`
- Modify: `server/control-api/cmd/control-api/main.go`

**Interfaces:**
- Consumes: `config.Config.DatabaseURL`
- Produces: `database.Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error)`
- Produces: `database.Migrate(ctx context.Context, pool *pgxpool.Pool) error`
- Produces tables: `users`, `user_sessions`, `devices`, `audit_logs`.

- [ ] **Step 1: Write a migration integration test**

```go
func TestMigrateCreatesIdentityTables(t *testing.T) {
	pool := openTestPool(t)
	if err := Migrate(context.Background(), pool); err != nil { t.Fatal(err) }
	for _, table := range []string{"users", "user_sessions", "devices", "audit_logs"} {
		var exists bool
		err := pool.QueryRow(context.Background(), `select to_regclass('public.' || $1) is not null`, table).Scan(&exists)
		if err != nil || !exists { t.Fatalf("table %s: exists=%v err=%v", table, exists, err) }
	}
}
```

- [ ] **Step 2: Run it against a disposable PostgreSQL and verify failure**

Run: `cd server/control-api; $env:TEST_DATABASE_URL='postgres://control:control@127.0.0.1:54329/control_test?sslmode=disable'; go test ./internal/database -run TestMigrateCreatesIdentityTables -v`

Expected: FAIL because `Migrate` does not exist.

- [ ] **Step 3: Add the strict identity migration**

Use UUID strings generated by Go and PostgreSQL `text` columns to keep the protocol language-neutral. Define constraints:

```sql
create type user_role as enum ('admin', 'operator');
create type user_status as enum ('active', 'disabled', 'deleted');

create table users (
  id text primary key,
  username text not null,
  username_normalized text not null unique,
  password_hash text not null,
  role user_role not null,
  status user_status not null default 'active',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_login_at timestamptz
);
```

`user_sessions` stores `token_digest bytea unique`, `purpose` constrained to `browser|desktop`, optional `device_id`, expiry, last-use, and revoke timestamps. `devices` stores owner, stable ID, versions, last-seen and disabled state. `audit_logs` is append-only and stores a JSONB metadata object with no secrets.

- [ ] **Step 4: Embed and run goose migrations**

Use `//go:embed migrations/*.sql`, pgx's `stdlib.OpenDBFromPool`, and `goose.SetBaseFS`. `Open` must parse pool config, set maximum connections to 10, minimum to 1, ping within five seconds, and return errors without embedding the connection URL.

- [ ] **Step 5: Make process startup fail closed on database or migration errors**

Update `main.go` to open the pool and run migrations before listening. Close the pool during shutdown. Do not serve authentication routes with an unavailable database.

- [ ] **Step 6: Verify and commit**

Run: `cd server/control-api; go test ./internal/database -v; go test ./...; go vet ./...`

Expected: PASS with `TEST_DATABASE_URL` set; integration test skips with an explicit message when it is absent.

Commit:

```powershell
git add server/control-api/internal/database server/control-api/cmd/control-api/main.go
git commit -m "feat: add control API identity database"
```

### Task 3: Argon2id Password Service

**Files:**
- Create: `server/control-api/internal/password/password.go`
- Create: `server/control-api/internal/password/password_test.go`

**Interfaces:**
- Produces: `password.Hash(plain string) (string, error)`
- Produces: `password.Verify(encoded, plain string) (match bool, needsRehash bool, err error)`
- Encoded format: `$argon2id$v=19$m=19456,t=2,p=1$<base64-salt>$<base64-hash>`.

- [ ] **Step 1: Write failing password tests**

```go
func TestHashAndVerify(t *testing.T) {
	encoded, err := Hash("correct horse battery staple")
	if err != nil { t.Fatal(err) }
	match, needsRehash, err := Verify(encoded, "correct horse battery staple")
	if err != nil || !match || needsRehash { t.Fatalf("match=%v rehash=%v err=%v", match, needsRehash, err) }
	wrong, _, _ := Verify(encoded, "wrong")
	if wrong { t.Fatal("wrong password matched") }
}

func TestHashUsesUniqueSalt(t *testing.T) {
	a, _ := Hash("same password")
	b, _ := Hash("same password")
	if a == b { t.Fatal("hashes must differ") }
}
```

- [ ] **Step 2: Verify failure**

Run: `cd server/control-api; go test ./internal/password -v`

Expected: FAIL because `Hash` and `Verify` do not exist.

- [ ] **Step 3: Implement bounded Argon2id encoding and constant-time verification**

Use 16 random salt bytes, 32 output bytes, 19 MiB, two iterations, one thread, and `subtle.ConstantTimeCompare`. Reject passwords shorter than 12 Unicode characters or longer than 1,024 UTF-8 bytes. Parse only the exact five-part format, cap accepted memory at 256 MiB, iterations at 10, and parallelism at 16 before allocating.

- [ ] **Step 4: Add malformed and oversized parameter tests**

Cover bad base64, wrong version, missing fields, `m=999999999`, an empty password, and a password over 1,024 bytes. Each must return a stable package error and never panic.

- [ ] **Step 5: Verify and commit**

Run: `cd server/control-api; go test ./internal/password -race -v`

Expected: PASS.

Commit: `git add server/control-api/internal/password; git commit -m "feat: add Argon2id password service"`

### Task 4: User, Session, and Audit Stores

**Files:**
- Create: `server/control-api/internal/users/store.go`
- Create: `server/control-api/internal/users/store_test.go`
- Create: `server/control-api/internal/sessions/store.go`
- Create: `server/control-api/internal/sessions/store_test.go`
- Create: `server/control-api/internal/audit/store.go`
- Create: `server/control-api/internal/audit/store_test.go`

**Interfaces:**
- Produces: `users.Store.Create(ctx, users.CreateInput) (users.User, error)`
- Produces: `users.Store.GetByNormalizedUsername(ctx, string) (users.UserWithPassword, error)`
- Produces: `users.Store.List(ctx) ([]users.User, error)`
- Produces: `users.Store.SetStatus(ctx, id string, status users.Status) error`
- Produces: `users.Store.ReplacePassword(ctx, id, encoded string) error`
- Produces: `sessions.Store.Create(ctx, sessions.CreateInput) (rawToken string, session sessions.Session, err error)`
- Produces: `sessions.Store.Authenticate(ctx, rawToken, purpose string) (users.User, sessions.Session, error)`
- Produces: `sessions.Store.RevokeToken(ctx, rawToken string) error`
- Produces: `sessions.Store.RevokeUser(ctx, userID string) error`
- Produces: `audit.Store.Append(ctx, audit.Event) error`.

- [ ] **Step 1: Write failing user-store integration tests**

Test normalization (`" Admin " -> "admin"`), duplicate normalized username rejection, no password hash in `users.User`, active/disabled transitions, and soft deletion retaining the row.

- [ ] **Step 2: Implement the user store with parameterized pgx queries**

Generate IDs with `crypto/rand` as 32 lowercase hexadecimal characters. Normalize usernames with trim plus Unicode lowercase, permit 3–64 characters from letters, digits, `.`, `_`, and `-`, and never interpolate SQL. Return `ErrUsernameTaken`, `ErrUserNotFound`, and `ErrLastAdmin` without leaking SQL text.

- [ ] **Step 3: Write failing session tests**

```go
func TestCreateStoresDigestNotRawToken(t *testing.T) {
	raw, session, err := store.Create(ctx, CreateInput{UserID:user.ID, Purpose:"desktop", TTL:time.Hour})
	if err != nil || len(raw) < 43 { t.Fatalf("raw=%q err=%v", raw, err) }
	if bytes.Contains(loadStoredDigest(t, session.ID), []byte(raw)) { t.Fatal("raw token persisted") }
}

func TestAuthenticateRejectsDisabledUserAndRevokedSession(t *testing.T) {
	raw, _, err := store.Create(ctx, CreateInput{UserID:user.ID, Purpose:"desktop", TTL:time.Hour})
	if err != nil { t.Fatal(err) }
	if err := userStore.SetStatus(ctx, user.ID, users.StatusDisabled); err != nil { t.Fatal(err) }
	if _, _, err := store.Authenticate(ctx, raw, "desktop"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("disabled user: %v", err)
	}
	if err := userStore.SetStatus(ctx, user.ID, users.StatusActive); err != nil { t.Fatal(err) }
	raw, _, err = store.Create(ctx, CreateInput{UserID:user.ID, Purpose:"desktop", TTL:time.Hour})
	if err != nil { t.Fatal(err) }
	if err := store.RevokeToken(ctx, raw); err != nil { t.Fatal(err) }
	if _, _, err := store.Authenticate(ctx, raw, "desktop"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked session: %v", err)
	}
}
```

- [ ] **Step 4: Implement opaque sessions**

Generate 32 random bytes and encode base64url without padding. Store `sha256(rawToken)`, use constant-time digest comparison after indexed lookup, enforce purpose, expiry, revocation, active user, and enabled device. Update `last_used_at` no more often than once every five minutes.

- [ ] **Step 5: Implement append-only audit events**

Allow action names from a package constant list and marshal a caller-provided metadata map after rejecting keys matching `password`, `token`, `secret`, `authorization`, or `api_key` case-insensitively. Tests must prove rejection.

- [ ] **Step 6: Verify transaction-level revocation behavior**

Password replacement and user disable tests must execute password/status change plus `RevokeUser` in one pgx transaction exposed by a small service in the next task; store methods themselves accept `pgx.Tx` through a shared `DBTX` interface.

- [ ] **Step 7: Verify and commit**

Run: `cd server/control-api; go test ./internal/users ./internal/sessions ./internal/audit -race -v`

Expected: PASS.

Commit: `git add server/control-api/internal/{users,sessions,audit}; git commit -m "feat: add identity persistence stores"`

### Task 5: One-Time Administrator CLI and Identity Service

**Files:**
- Create: `server/control-api/internal/identity/service.go`
- Create: `server/control-api/internal/identity/service_test.go`
- Create: `server/control-api/cmd/control-api-admin/main.go`
- Create: `server/control-api/cmd/control-api-admin/main_test.go`

**Interfaces:**
- Produces: `identity.Service.CreateInitialAdmin(ctx, username, password string) (users.User, error)`
- Produces: `identity.Service.CreateOperator(ctx, actor users.User, username, password string) (users.User, error)`
- Produces: `identity.Service.ResetPassword(ctx, actor users.User, userID, newPassword string) error`
- Produces: CLI subcommands `admin create` and `admin reset-password` with password read from terminal/stdin.

- [ ] **Step 1: Write failing service tests**

Test that the first admin can be created, a second initial admin returns `ErrAdminAlreadyExists`, no operator is seeded, non-admin actors cannot create/reset users, password reset revokes sessions, and all mutations append audit records.

- [ ] **Step 2: Implement atomic identity operations**

Use one pgx transaction per operation. `CreateInitialAdmin` locks a singleton advisory key, counts non-deleted administrators, rejects a second bootstrap, hashes the password, inserts role `admin`, writes `admin.created`, and commits. `ResetPassword` writes the new hash, revokes every user session, writes `user.password_reset`, and commits.

- [ ] **Step 3: Write failing CLI tests using injected streams**

```go
func TestCreateDoesNotAcceptPasswordFlag(t *testing.T) {
	err := run([]string{"admin", "create", "--username", "owner", "--password", "leak"}, strings.NewReader(""), io.Discard)
	if !errors.Is(err, errUnknownFlag) { t.Fatalf("got %v", err) }
}
```

Also test that output never contains the supplied password and that empty/mismatched confirmation fails before database access.

- [ ] **Step 4: Implement the CLI**

Accept only `--username`. Read password and confirmation with terminal echo disabled when a terminal is available; accept two newline-separated values from stdin for automation. Do not put passwords in environment variables or arguments. Print only the created username and ID.

- [ ] **Step 5: Verify and commit**

Run: `cd server/control-api; go test ./internal/identity ./cmd/control-api-admin -race -v; go vet ./...`

Expected: PASS.

Commit: `git add server/control-api/internal/identity server/control-api/cmd/control-api-admin; git commit -m "feat: add administrator bootstrap CLI"`

### Task 6: Login, Logout, Current User, and Authentication Middleware

**Files:**
- Create: `server/control-api/internal/httpapi/json.go`
- Create: `server/control-api/internal/httpapi/auth.go`
- Create: `server/control-api/internal/httpapi/auth_test.go`
- Create: `server/control-api/internal/ratelimit/login.go`
- Create: `server/control-api/internal/ratelimit/login_test.go`
- Modify: `server/control-api/internal/httpapi/router.go`
- Modify: `server/control-api/openapi/openapi.yaml`

**Interfaces:**
- Produces: `POST /api/v1/auth/login`
- Produces: `POST /api/v1/auth/logout`
- Produces: `GET /api/v1/auth/me`
- Produces: `httpapi.RequireSession(purpose string, next http.Handler) http.Handler`
- Login input: `{username:string,password:string,purpose:"browser"|"desktop",deviceId?:string}`
- Desktop response: `{user:User,accessToken:string,expiresAt:string}`; browser response sets cookie and omits `accessToken`.

- [ ] **Step 1: Write HTTP tests before handlers**

Cover malformed JSON, body over 32 KiB, wrong credentials returning the same `INVALID_CREDENTIALS` response, disabled user, browser cookie flags, desktop bearer token, purpose mismatch, logout revocation, `GET /me`, `Cache-Control: no-store`, and request IDs in errors.

- [ ] **Step 2: Verify failure**

Run: `cd server/control-api; go test ./internal/httpapi -run 'Test(Login|Logout|Me)' -v`

Expected: FAIL because routes return 404.

- [ ] **Step 3: Implement bounded JSON and stable errors**

Use `http.MaxBytesReader`, `json.Decoder.DisallowUnknownFields`, require exactly one JSON value, and send:

```go
type APIError struct { Code string `json:"code"`; Message string `json:"message"`; RequestID string `json:"requestId"` }
```

Never return raw database, Argon2, or internal errors.

- [ ] **Step 4: Implement login rate limiting**

Use an in-memory token bucket keyed by normalized username plus canonical remote IP: five attempts per five minutes, maximum 10, periodic eviction after 30 minutes. Trust proxy headers only when an explicit `TRUSTED_PROXY_CIDRS` configuration contains the direct peer; otherwise use `RemoteAddr`.

- [ ] **Step 5: Implement login and authentication middleware**

Always perform one real or dummy Argon2 verification to reduce username enumeration timing differences. On success, create the correct session purpose, update last login, audit `auth.login_succeeded`, and return browser cookie or desktop token. On failure, audit only normalized username and source, then return 401. Cookie name is `control_session`, path `/`, Secure from config, HttpOnly, SameSiteStrict, and MaxAge equal to TTL.

- [ ] **Step 6: Implement logout and `/me`**

Logout accepts only the currently authenticated cookie or bearer token, revokes it, expires the browser cookie, records `auth.logout`, and returns 204. `/me` returns only public user fields.

- [ ] **Step 7: Verify contract and commit**

Run: `cd server/control-api; go test ./internal/httpapi ./internal/ratelimit -race -v; go test ./...; go vet ./...`

Expected: PASS and OpenAPI includes exact cookie/bearer security schemes.

Commit: `git add server/control-api; git commit -m "feat: add control API authentication"`

### Task 7: Administrator User Management API

**Files:**
- Create: `server/control-api/internal/httpapi/admin_users.go`
- Create: `server/control-api/internal/httpapi/admin_users_test.go`
- Modify: `server/control-api/internal/httpapi/router.go`
- Modify: `server/control-api/openapi/openapi.yaml`

**Interfaces:**
- Produces: `GET /api/v1/admin/users`
- Produces: `POST /api/v1/admin/users`
- Produces: `PATCH /api/v1/admin/users/{id}`
- Produces: `POST /api/v1/admin/users/{id}/reset-password`
- Produces: `POST /api/v1/admin/users/{id}/revoke-sessions`

- [ ] **Step 1: Write authorization and mutation tests**

Test unauthenticated 401, operator 403, admin success, duplicate username 409, invalid role/status 422, no raw password in response, disable revoking sessions atomically, password reset revoking sessions, inability to disable/delete the last active admin, and audit creation.

- [ ] **Step 2: Implement admin-only routing**

Wrap `/api/v1/admin` with browser-purpose authentication and an explicit role check. Do not infer administrator access from the route caller or username.

- [ ] **Step 3: Implement list and create**

List ordered by creation time and return public fields only. Create accepts `{username,password,role}` where role is `admin|operator`; no default operator is inserted by migrations or process startup.

- [ ] **Step 4: Implement status, reset, and revoke operations**

PATCH accepts only `{status:"active"|"disabled"}`. Disabling and password reset revoke all target sessions in the same transaction. Revoke-sessions leaves the current administrator's session active only when the target is that administrator and request body contains `{preserveCurrent:true}`; otherwise revoke all.

- [ ] **Step 5: Update OpenAPI examples and stable errors**

Document `USERNAME_TAKEN`, `LAST_ADMIN_REQUIRED`, `USER_NOT_FOUND`, `INVALID_INPUT`, `UNAUTHENTICATED`, and `FORBIDDEN`; all errors include request IDs.

- [ ] **Step 6: Verify and commit**

Run: `cd server/control-api; go test ./internal/httpapi -run TestAdminUsers -race -v; go test ./...; go vet ./...`

Expected: PASS.

Commit: `git add server/control-api; git commit -m "feat: add administrator user management API"`

### Task 8: Production Container, Local Compose, Documentation, and Full Verification

**Files:**
- Create: `server/control-api/Dockerfile`
- Create: `server/control-api/compose.yaml`
- Create: `server/control-api/.env.example`
- Create: `server/control-api/README.md`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Produces: `docker compose up --build` local stack bound to `127.0.0.1`.
- Produces: documented bootstrap, login, backup, restore, migration, rotate, and shutdown procedures.

- [ ] **Step 1: Write a container smoke script as a Go integration test**

Add `server/control-api/integration/smoke_test.go` that reads `CONTROL_API_URL`, waits up to 30 seconds for `/healthz`, asserts the fixed service identity, logs in with a test admin from a disposable database, calls `/me`, logs out, and asserts the old token receives 401.

- [ ] **Step 2: Create a reproducible non-root image**

Use `golang:1.26.5-alpine` as builder, run `go mod download`, build both binaries with `CGO_ENABLED=0`, and copy them into `gcr.io/distroless/static-debian12:nonroot`. Add OCI source/license labels. Do not copy `.env`, database dumps, media, or root project secrets.

- [ ] **Step 3: Create loopback-only Compose configuration**

Use PostgreSQL 16 with a named volume and health check. Bind API to `127.0.0.1:8080` and PostgreSQL to `127.0.0.1:54329`. Compose is development-only and sets `COOKIE_SECURE=false`; production documentation requires TLS and `COOKIE_SECURE=true`.

- [ ] **Step 4: Document exact operations**

Document:

```powershell
docker compose up -d postgres
docker compose run --rm control-api-admin admin create --username owner
docker compose up -d control-api
go test ./...
go vet ./...
```

Include PostgreSQL backup/restore, session revocation, password reset, log redaction, trusted proxy configuration, and no-public-registration statements.

- [ ] **Step 5: Update notices and repository security guidance**

Add chi, pgx, goose, and x/crypto licenses to `THIRD_PARTY_NOTICES.md`. Update `SECURITY.md` to prohibit posting session tokens, password hashes, database URLs, audit exports, AI keys, RTC secrets, and candidate information.

- [ ] **Step 6: Run complete verification**

Run:

```powershell
Set-Location server/control-api
go mod verify
go test ./... -race
go vet ./...
docker compose config
docker compose build
```

Then start the disposable stack and run:

```powershell
$env:CONTROL_API_URL='http://127.0.0.1:8080'
go test ./integration -run TestSmoke -v
```

Expected: all commands PASS; logout makes the previous token return 401; no secrets appear in container logs.

- [ ] **Step 7: Run existing project regression checks**

Run from repository root:

```powershell
npm run build
npm run build:desktop
npm run test:desktop-shell
```

Expected: all existing client checks PASS because this phase does not change Electron or Next.js behavior.

- [ ] **Step 8: Commit the deployable authentication service**

```powershell
git add server/control-api README.md SECURITY.md THIRD_PARTY_NOTICES.md .gitignore docs/dependency-decisions.md
git commit -m "docs: add control API deployment workflow"
```

## Completion Gate

Before starting the management-web plan, verify all of the following:

- A fresh PostgreSQL database migrates automatically and repeat startup is idempotent.
- The CLI creates exactly one initial administrator and no ordinary users.
- Passwords are Argon2id hashes and never appear in arguments, logs, API responses, or database plaintext.
- Browser and desktop sessions are purpose-bound, revocable, expiring, and represented in the database only by SHA-256 digests.
- Disabled users and reset-password users lose existing sessions immediately.
- An administrator can create an operator through the API, but no operator exists by default.
- OpenAPI matches every implemented route, schema, cookie, bearer scheme, and stable error code.
- Container and local Compose verification pass, and existing Windows client tests remain green.

After this gate, create separate plans in this order:

1. Next.js management web login and user administration;
2. centralized AI configuration and inference proxy;
3. centralized RTC configuration and token issuance;
4. Electron login, secure token storage, configuration pull, device heartbeat, and forced logout;
5. optional candidate-record upload only after a separate privacy and retention design is approved.
