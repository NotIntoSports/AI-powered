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
| RTC | `/settings/rtc` | **LiveKit only** (火山 RTC removed). Connection + interactive pipeline binding: `cascaded` (ASR+LLM+TTS) or `e2e`, with searchable catalog comboboxes and TTS voice preview |
| Speech | `/settings/speech` | Active provider `aliyun` or `volcengine` (豆包); Alibaba CosyVoice/NLS presets + preview; ASR/TTS params |
| Pipeline | `/settings/pipeline` | High-level mode / cascaded TTS provider / E2E provider toggles (complements RTC page binding) |
| Storage | `/settings/storage` | Tencent COS for resumes |
| Roles | `/settings/roles` | Locked role prompts (HR / assistant / interviewer / candidate) |
| Materials | `/resumes` | Upload / index / download reference docs |

Desktop clients consume encrypted-at-rest settings after login:

- `GET /api/v1/client/settings/pipeline` — mode + bound models (no silent E2E→cascaded fallback)
- `GET /api/v1/client/settings/ai` / `asr` / `speech`
- `POST /api/v1/client/rtc/token` — LiveKit JWT only

## Run locally

Start PostgreSQL and the API first (`server/control-api/README.md`), then:

```powershell
Copy-Item .env.example .env.local
Set-Location server/management-web
npm install
npm run dev
```

Open `http://127.0.0.1:3001`. The Next.js server proxies `/api/v1` to
`CONTROL_API_ORIGIN` (default `http://127.0.0.1:8080`) so the browser stays
same-origin for the `control_session` cookie.

Production requires TLS and `COOKIE_SECURE=true` on the API. Do not publish this
console beyond a trusted network without TLS. Deploy compose lives in
`server/deploy` (HTTP:80 nginx in front of `management-web`).
