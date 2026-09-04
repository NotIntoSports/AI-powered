# Current Capability Inventory

This inventory describes the legacy system at commit `5f8a86038112e5b3214938a9c60a2e2b47458bdf`. `keep` means retain the capability as-is during the parallel foundation phase, `migrate` means re-home it in the desktop monolith, and `delete` means remove it only after the replacement acceptance gate passes.

## Desktop client pages

| Current route | Capability | Decision | Destination |
| --- | --- | --- | --- |
| `/` | Interview workspace and answer controls | migrate | Design 6.1 Workbench; 12 Runtime and audio |
| `/login` | Remote session login | delete | Design 3.1 no-login product model |
| `/records` | Session history and exports | migrate | Design 6.3 Records; 15 Session data |
| `/settings` | Client configuration | migrate | Design 6.5 Settings and diagnostics; 7 Configuration |
| `/stage` | Device, speech, OBS, and pipeline checks | migrate | Design 6.5 Settings and diagnostics; 13 gates and recovery |

## Server management pages

| Current route | Capability | Decision | Destination |
| --- | --- | --- | --- |
| `/login` | Administrator login | delete | Design 3.1 no-login product model |
| `/overview` | Service and user overview | delete | Local diagnostics replace service overview; multi-user status is removed |
| `/users` | User administration | delete | Design 4 out of scope |
| `/sessions` | Global session administration | delete | User-owned local records in Design 6.3 and 15 |
| `/resumes` | Resume upload, download, delete, reindex | migrate | Design 6.2 Materials; 14 SQLite materials and vectors |
| `/settings/ai` | AI providers, models, discovery, tests | migrate | Design 6.4 Services; 8 secrets; 11 adapters |
| `/settings/roles` | Assistant role profiles | migrate | Design 6.5 Settings; local configuration |
| `/settings/rtc` | RTC provider configuration | migrate | Design 12.2 optional LiveKit |
| `/settings/speech` | ASR/TTS and voice routes | migrate | Design 6.4 Services; 12.3 voice routes |
| `/settings/storage` | Server object storage | delete | Design 14 and 16 local SQLite/files/backup |

## Desktop Next.js API routes

| Domain and routes | Decision | Destination |
| --- | --- | --- |
| Health and stage: `/api/health`, `/api/stage-status`, `/api/stage-test-speech` | migrate | Rust diagnostics and readiness commands, Design 13 and 17 |
| Session: `/api/session`, `/api/sessions*`, `/api/session/export` | migrate | Rust SQLite session repository, Design 15 and 16 |
| Resume/knowledge: `/api/resume*`, `/api/knowledge/search` | migrate | Rust SQLite/FTS5/sqlite-vec, Design 14 |
| Speech: `/api/tts`, `/api/voice-clone` | migrate | Rust provider adapters, Design 11 and 12 |
| RTC/control: `/api/rtc/token`, `/api/control-session` | migrate | Direct runtime first; optional LiveKit adapter, Design 12 |
| OBS/avatar: `/api/obs/runtime`, `/api/avatar`, `/api/avatar/media` | migrate | Rust OBS and media services, Design 6.1 and 12 |
| Pipeline logging: `/api/pipeline-log` | migrate | Redacted local diagnostics, Design 17 |

## Control API domains

| Current domain | Decision | Destination |
| --- | --- | --- |
| Authentication and browser sessions | delete | No login; local process boundary |
| Users, devices, presence, session revocation | delete | Single-user desktop model |
| Audit logs | migrate | Bounded redacted local diagnostics, Design 17 |
| AI providers, model discovery/catalog, activation, probes | migrate | Local config + Credential Manager + adapters, Design 7, 8, 11 |
| Speech configuration, previews, ASR probes, voices | migrate | Local services and voice routes, Design 11 and 12.3 |
| RTC configuration and token issuing | migrate | Optional LiveKit only, Design 12.2 |
| Assistant roles and pipeline configuration | migrate | Versioned local configuration, Design 7 |
| Object storage configuration | delete | Local files and backup, Design 14 and 16 |
| Resumes and knowledge search/reindex | migrate | Local SQLite/FTS5/sqlite-vec, Design 14 |
| Voice samples and per-user voice allocation | migrate | Local materials/config/secrets, Design 12.3 and 14 |
| Agent-only voice-route snapshot | delete | In-process Rust runtime receives typed local state |
| Control API admin CLI and MCP administration | delete | No remote administration surface |

## Python Agent modes

| Current mode | Decision | Destination |
| --- | --- | --- |
| Cascaded ASR → LLM → TTS | migrate | Rust Direct runtime, Design 12.1 and phase 5 |
| End-to-end request/response audio | migrate | Rust provider adapter, Design 11 and phase 7 |
| Realtime bidirectional audio | migrate | Rust realtime adapter after cascaded path, Design 12 and phase 7 |
| `ai-active` / paused response state | migrate | Rust session state machine, Design 12.4 |
| LiveKit room worker and command channel | delete | Optional adapter only after Direct path works, Design 12.2 |

## Electron IPC groups

| Current IPC group | Commands | Decision | Destination |
| --- | --- | --- | --- |
| Desktop status | `desktop:get-status` | migrate | Typed Tauri diagnostics command, Design 10 and 13 |
| Meeting process/audio capture | list/start/stop capture | migrate | Rust Windows/runtime service, Design 12 and phase 6 |
| Prerequisites | status/ensure/install | migrate | Rust prerequisite service, Design 13 and phase 6 |
| Managed OBS | ensure/state/camera/routing/stop/reset | migrate | Rust OBS service, Design 12 and phase 6 |
| Windows settings | open microphone settings | migrate | Narrow Tauri command, Design 9 and 10 |

## AudioBridge commands

| Command | Decision | Destination |
| --- | --- | --- |
| `--self-test` | keep | C# sidecar health gate during phase 1 |
| `--pid <positive process id>` | keep | Process-tree loopback capture sidecar during phase 1 |
| `--set-default-communications-mic` | keep | Windows communications routing during phase 1 |
| `--restore-default-communications-mic <endpoint id>` | keep | Guaranteed cleanup during phase 1 |

## Current PostgreSQL tables

| Table | Decision | Destination |
| --- | --- | --- |
| `users`, `devices`, `user_sessions` | delete | No-login single-user model |
| `audit_logs` | migrate | Local bounded diagnostic events, Design 17 |
| `ai_provider_configs`, `discovered_models` | migrate | Versioned JSON metadata; secrets in Credential Manager, Design 7 and 8 |
| `rtc_configs` | migrate | Optional LiveKit configuration, Design 12.2 |
| `object_storage_configs` | delete | Local storage, Design 14 and 16 |
| `resumes`, `knowledge_chunks` | migrate | SQLite material, chunk, FTS and vector tables, Design 14 |
| `speech_configs`, `pipeline_configs` | migrate | Versioned local configuration, Design 7 and 12 |
| `user_speech_voices`, `voice_routes` | migrate | Local voice route metadata; secret references only, Design 12.3 |
| `assistant_role_profiles` | migrate | Local role profiles, Design 7 |
| `token_plan_official_models`, `token_plan_catalog_sync`, `token_plan_model_status` | migrate | Local provider catalog cache, Design 11 |

## Packaging resources

| Current resource | Decision | Destination |
| --- | --- | --- |
| Electron runtime and `dist-desktop` | delete | Tauri executable after cutover gate, phase 8 |
| `.desktop-runtime` Next standalone server and Node modules | delete | Rust commands and Vite assets, phase 8 |
| `native/AudioBridge/publish` | keep | Tauri sidecar resource during phase 1 |
| Prerequisite installers and PowerShell installers | migrate | Tauri resources with Rust orchestration, phase 6 |
| License and third-party notices | keep | Tauri bundle resources |
| NSIS installer customization | migrate | Tauri Windows bundler/NSIS configuration |

## Deployment services

| Current service | Decision | Destination |
| --- | --- | --- |
| PostgreSQL + pgvector | delete | Embedded SQLite + FTS5 + sqlite-vec, Design 14 |
| Control API | delete | Rust in-process application services |
| Management web | delete | Desktop Services/Settings/Diagnostics pages |
| Infinity embedding + nginx proxy | migrate | User-selected local or third-party embedding adapter, Design 11 and 14 |
| LiveKit server | migrate | Optional third-party service only, Design 12.2 |
| Python LiveKit Agent | delete | Rust Direct runtime and optional adapters |
| Deployment nginx | delete | No author-operated web management surface |
| Control API admin/bootstrap and MCP profiles | delete | No server administration plane |

## Review rule

No `delete` item may be removed merely because it appears in this inventory. Removal is allowed only when its destination capability passes the matching acceptance gate in Design 20 and the public cutover criteria in Design 26.
