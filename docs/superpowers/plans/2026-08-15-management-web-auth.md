# Management Web Login and User Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated Next.js management console that logs administrators in with the existing Go control API cookie session and lets them list, create, disable, reset, and revoke users.

**Architecture:** Keep the interview Electron/Next.js app untouched. Put a second App Router app in `server/management-web` that same-origin-proxies `/api/v1` to `control-api` so `control_session` (`HttpOnly; SameSite=Strict`) stays first-party. No public registration, no AI/RTC config, no candidate data.

**Tech Stack:** Next.js 15.4 (App Router, MIT), React 19.1, TypeScript 5.8, existing Go control-api `/api/v1/auth` and `/api/v1/admin/users`.

## Global Constraints

- Do not create any ordinary client user during bootstrap; only the administrator CLI may create the first `admin`.
- Do not expose public registration, password recovery, social login, OIDC, SAML, MFA, or multi-tenancy.
- Passwords and session tokens never enter command-line arguments, logs, localStorage, or sessionStorage.
- Browser sessions use `HttpOnly; Secure; SameSite=Strict` cookies named `control_session`.
- All authenticated and authentication responses use `Cache-Control: no-store` and stable `{code,message,requestId}` errors.
- Candidate media, transcripts, interview records, AI credentials, RTC credentials, OBS, audio, and desktop behavior are out of scope.
- Do not change Electron or the existing interview Next.js routes in this plan.
- Bind the management web to loopback in development (`127.0.0.1:3001`).

---

## File Map

- `server/management-web/package.json`: isolated Next.js 15.4 app, same React/Next majors as the interview client.
- `server/management-web/next.config.ts`: standalone output; rewrite `/api/v1/:path*` to `CONTROL_API_ORIGIN`.
- `server/management-web/middleware.ts`: cookie gate for console routes; never inspect token values beyond presence.
- `server/management-web/app/login/page.tsx`: username/password only; `purpose: "browser"`; no register/forgot links.
- `server/management-web/app/users/page.tsx`: list/create/disable/enable/reset/revoke against admin API.
- `server/management-web/lib/control-api.ts`: typed fetch helpers; never log bodies that may contain passwords.
- `server/management-web/README.md`: run, proxy, production TLS notes.
- Modify: root `README.md`, `docs/dependency-decisions.md`, `server/control-api/compose.yaml`.

### Task 1: Scaffold the isolated app, proxy, login, and user console

**Files:** listed above.

- [ ] **Step 1: Write failing tests** for login body always using `purpose: "browser"`, error parser never treating password fields as display text, and login markup containing no 注册/找回.

- [ ] **Step 2: Implement the Next.js app** with rewrite proxy, login, logout, `/me` gate, and admin user operations. Operator API 403 shows a forbidden state, not a user list.

- [ ] **Step 3: Document and wire Compose** on `127.0.0.1:3001`. Do not add a public signup route.

- [ ] **Step 4: Verify** `npm test` in `server/management-web`, `npm run build` there, and existing root `npm run test:desktop-shell` still passes.

Commit: `feat: add management web login and user administration`
