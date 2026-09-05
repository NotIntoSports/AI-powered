# Management web

Administrator console for the **AI虚拟助手** `control-api`. There is no public
registration or password recovery. Secrets are never shown in the browser after
save (only “已配置” flags).

Default first admin (empty DB): `admin` / `adminqaz` — seeded by `control-api`
via `INITIAL_ADMIN_*`. Change the password after first login.

## What the console does now

| Area | Route | Behavior |
| --- | --- | --- |
| Overview | `/overview` | Online accounts / current session lines |
| Users | `/users` | Create, disable, reset password, revoke sessions, voice bind visibility |
| Models | `/settings/ai` | **Multiple** OpenAI-compatible AI lines (CRUD, activate default, discover models, enable/disable) |
| RTC | `/settings/rtc` | **LiveKit only** (火山 RTC removed). URL, API Key/Secret, subtitle language, enable flag, connection test, Agent status |
| Speech | `/settings/speech` | **Voice routes** (create/edit/copy/test/activate one cascaded or e2e route) plus Alibaba/豆包 credentials and CosyVoice preview |
| Storage | `/settings/storage` | Tencent COS for resumes |
| Roles | `/settings/roles` | Locked role prompts (HR / assistant / interviewer / candidate) |
| Materials | `/resumes` | Upload / index / download reference docs |

Desktop clients no longer receive model keys or pipeline endpoints. After login they:

- join LiveKit with `POST /api/v1/client/rtc/token` (LiveKit JWT only);
- send versioned session context and `agent.command.v1` over data channels;
- keep `/api/v1/client/settings/speech` only for cloned-voice allocation, not session ASR/TTS.

## Run locally

Start PostgreSQL and the API first (`server/control-api/README.md`), then:

```powershell
Copy-Item .env.example .env.local
Set-Location server/management-web
npm install
npm run dev
```

Open `http://127.0.0.1:3001`. The Next.js server proxies `/api/v1` only when
`BACKEND_ORIGIN` is set (no default host) so the browser stays same-origin
for the session cookie.

Production requires TLS and `COOKIE_SECURE=true` on the API. Do not publish this
console beyond a trusted network without TLS. Deploy compose lives in
`server/deploy` (HTTP:80 nginx in front of `management-web`).
