# Management web

Administrator console for the **AI虚拟助手** `control-api`. After login it shows account online status, current session lines, user administration, and AI/RTC/speech/storage settings that are written to PostgreSQL. The **资料** page lists uploaded reference materials (PDF/Word) for indexing and download. RTC settings keep 火山云 and LiveKit as two cards plus a current-line switch. Speech settings keep 阿里云 NLS and 豆包 as collapsible cards with connectivity status on the summary. There is no public registration or password recovery. Secrets are never shown in the browser after save.

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
