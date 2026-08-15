# Management web

Administrator console for `server/control-api`. It has login and user management only: no public registration, password recovery, AI keys, RTC secrets, or candidate records.

## Run locally

Start PostgreSQL and the API first (`server/control-api/README.md`), create the initial admin with the CLI, then:

```powershell
Copy-Item .env.example .env.local
Set-Location server/management-web
npm install
npm run dev
```

Open `http://127.0.0.1:3001`. The Next.js server proxies `/api/v1` to `CONTROL_API_ORIGIN` (default `http://127.0.0.1:8080`) so the browser stays same-origin for the `control_session` cookie.

Production requires TLS and `COOKIE_SECURE=true` on the API. Do not publish this console beyond a trusted network without TLS.
