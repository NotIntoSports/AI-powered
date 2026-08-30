# Control API

Private Go management API for administrator accounts, revocable sessions, and
audit events. It is separate from the Electron/Next.js **AI虚拟助手** client and
**does not offer public registration**. On first start with an empty user table,
`control-api` seeds `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` (defaults
`admin` / `adminqaz`). If an administrator already exists, startup leaves that
password unchanged. Operators are created only by an existing administrator.

Compose in this directory is **development-only**. It binds the API to
`127.0.0.1:8080` and PostgreSQL to `127.0.0.1:54329`, and sets
`COOKIE_SECURE=false` so browser cookies work over local HTTP. Production must
terminate TLS and set `COOKIE_SECURE=true`.

## Local Compose bootstrap

Copy `.env.example` to `.env` and replace every placeholder. Compose substitutes
`POSTGRES_PASSWORD` and `DATABASE_URL` from that file. Do not commit `.env`.

From this directory:

```powershell
docker compose up -d postgres
docker compose up -d control-api embedding
go test ./...
go vet ./...
```

Empty databases get the default administrator (`admin` / `adminqaz` unless
`INITIAL_ADMIN_*` is set in `.env`). Optional CLI bootstrap still works:

```powershell
docker compose run --rm control-api-admin admin create --username owner
```

`admin create` and `admin reset-password` read the password from an interactive
terminal or two matching stdin lines when you want a non-default password.
Startup seeding never overwrites an existing administrator.

Resume indexing uses the `embedding` service (TEI `cpu-1.9` + `BAAI/bge-m3`) on
the compose network only. It does not publish a host port. `control-api` starts
even if the model weights are still downloading; follow-up questions degrade to
empty knowledge until the index is ready.

Optional LiveKit line (default `activeProvider` stays `volcengine`):

```powershell
docker compose --profile livekit up -d livekit
npm run test:livekit-smoke
npm run test:livekit-load
```

`livekit-agent` is in the same profile and only emits `subtitle.v1` JSON when
`LIVEKIT_ASR_API_KEY` is set. Do not run local Whisper/FunASR on the 4C8G host.

The API process is `control-api`. `control-api-admin` is a one-shot bootstrap
profile and is not started by `docker compose up -d`.

Health check: `GET http://127.0.0.1:8080/healthz` returns
`{"service":"control-api","status":"ok"}`.

The administrator browser console is `server/management-web` on
`http://127.0.0.1:3001`. It proxies `/api/v1` to this API and has no public
registration. After the API is up: `docker compose up -d management-web` or
`npm run dev` in `server/management-web`.

Browser login uses `POST /api/v1/auth/login` with JSON
`{"username":"...","password":"...","purpose":"browser"}` and the
`control_session` cookie. Desktop clients use `purpose: "desktop"` and
`Authorization: Bearer`. Logout is `POST /api/v1/auth/logout`; the current
principal is `GET /api/v1/auth/me`.

Optional smoke test against a running stack (credentials stay in env, never in
the test log):

```powershell
$env:CONTROL_API_URL='http://127.0.0.1:8080'
$env:CONTROL_API_USERNAME='owner'
$env:CONTROL_API_PASSWORD='replace-with-admin-password'
go test ./integration -run TestSmoke -v
```

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | PostgreSQL URL. Production should use TLS (`sslmode=require` or stricter). |
| `LISTEN_ADDRESS` | no | `127.0.0.1:8080` | Compose sets `0.0.0.0:8080` inside the container so the host loopback publish works. |
| `SESSION_TTL` | no | `8h` | Minimum `15m`. |
| `COOKIE_SECURE` | no | `true` | Compose sets `false` for local HTTP. Production must use `true` behind TLS. |
| `TRUSTED_PROXY_CIDRS` | no | empty | Comma-separated CIDRs. Forwarded client IPs are trusted only when the TCP peer matches. |
| `SETTINGS_MASTER_KEY` | no | empty | 64 hex characters (32 bytes). Encrypts AI API keys and RTC secrets in PostgreSQL. Required before saving settings; GET of empty config still works without it. |
| `KNOWLEDGE_PROVIDER` | no | `local-pgvector` | Knowledge backend. Unknown values fail startup. Phase one only registers `local-pgvector`. |
| `EMBEDDING_BASE_URL` | no | `http://127.0.0.1:8090` | OpenAI-compatible TEI base URL. Compose sets `http://embedding:80` on the internal network and does not publish a host port. |
| `EMBEDDING_MODEL` | no | `BAAI/bge-m3` | Embedding model id stored with chunks. Changing it requires a full reindex. |
| `INITIAL_ADMIN_USERNAME` | no | `admin` | Seeded only when no administrator exists. |
| `INITIAL_ADMIN_PASSWORD` | no | `adminqaz` | Seeded only when no administrator exists. Changing this env later does not reset an existing password. |

The HTTP server applies embedded goose migrations on start. Empty databases are
created and upgraded automatically; keep a backup before upgrading a populated
store.

## PostgreSQL backup and restore

Keep dumps off the image and out of git. Run these from the compose directory
after the database is healthy. The `pgvector/pgvector:pg16` container already has
`POSTGRES_USER` and `POSTGRES_DB`; do not put `DATABASE_URL` or the password on
the command line.

Backup (custom format; filename matches `*.dump` ignore rules):

```powershell
docker compose exec -T postgres bash -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /tmp/backup.dump'
docker compose cp postgres:/tmp/backup.dump ./backup.dump
```

Restore into the named volume (this replaces objects in the target database).
Stop `control-api` first so it does not hold connections or rewrite objects
while `pg_restore --clean` runs, then start it again after restore completes:

```powershell
docker compose stop control-api
docker compose cp ./backup.dump postgres:/tmp/backup.dump
docker compose exec -T postgres bash -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists /tmp/backup.dump'
docker compose start control-api
```

Host-side tools can also use `127.0.0.1:54329`. Do not paste `DATABASE_URL` into
shell history, tickets, or logs.

## Session revocation

An administrator with a browser session can revoke another user's sessions:

`POST /api/v1/admin/users/{id}/revoke-sessions`

JSON `{"preserveCurrent": true}` keeps the caller's current session when the
target is the caller. Omit it or set `false` to revoke every session for that
user. Revoked cookies and bearer tokens then receive `401` on `/api/v1/auth/me`.

## Password reset

CLI (password from the terminal or two stdin lines, never flags or env):

```powershell
docker compose run --rm control-api-admin admin reset-password --username owner
```

API (administrator browser session):

`POST /api/v1/admin/users/{id}/reset-password` with JSON `{"password":"..."}`.

Resetting a password revokes that user's sessions. Rotate the password, then
confirm old cookies and tokens return `401`.

## Log redaction

Do not write passwords, password hashes, session tokens, `Authorization` or
`Cookie`/`Set-Cookie` values, `DATABASE_URL`, audit export files, AI keys, RTC
secrets, or candidate information to container logs, CI logs, or issue trackers.
The service logs configuration errors without echoing the database URL. Prefer
request IDs from JSON error bodies when diagnosing failures.

## Trusted proxies

Leave `TRUSTED_PROXY_CIDRS` empty unless a reverse proxy terminates TLS in
front of the API. Only list the proxy's CIDRs. Production still requires TLS to
the proxy and `COOKIE_SECURE=true`.

## Production

- Place TLS in front of the API (reverse proxy or equivalent).
- Set `COOKIE_SECURE=true` (the process default).
- Do not publish PostgreSQL or the API on `0.0.0.0`.
- Do not enable public registration; there is no signup route.
- Rebuild and restart `control-api` after image updates; startup reapplies
  migrations.
- Shut down the local stack with `docker compose down`. Add `-v` only when the
  named PostgreSQL volume should be discarded.

## Image

Multi-stage build from this directory (`server/control-api`):

- Builder: official `golang:1.26.5-alpine`, `go mod download`, `CGO_ENABLED=0`
  builds of `control-api` and `control-api-admin`.
- Runtime: `gcr.io/distroless/static-debian12:nonroot` (no shell). Default
  entrypoint is `/control-api`.

The image does not copy `.env`, dumps, media, or repository secrets.
