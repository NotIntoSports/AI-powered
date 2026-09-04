# Legacy Desktop Baseline

- Commit: `5f8a86038112e5b3214938a9c60a2e2b47458bdf`
- Measured at: `2026-09-04` inventory capture; resource measurements have not been run because no packaged executable or installer was supplied
- OS: Microsoft Windows 11 Home (`10.0.26200`)
- Toolchain: Rust 1.96.0; Node 24.14.0; .NET 10.0.303; Go 1.26.2; Python 3.12.10
- Measurement command: `npm run measure:legacy -- -ExecutablePath dist/win-unpacked/AI-Virtual-Assistant.exe -InstallerPath dist/AI-Virtual-Assistant-0.1.0-Windows-x64.exe -RuntimePath dist/win-unpacked -OutputPath docs/migration/legacy-baseline.json`

| Metric | Value | Status |
| --- | ---: | --- |
| Installer bytes | `not-built` | No installer path was supplied; evidence pending |
| Runtime bytes | `not-built` | No packaged runtime path was supplied; evidence pending |
| Startup milliseconds | `not-run` | No packaged executable path was supplied; evidence pending |
| Idle working set bytes | `not-run` | No packaged executable path was supplied; evidence pending |
| Idle CPU percent | `not-run` | No packaged executable path was supplied; evidence pending |

The script also supports a no-argument contract run. In that mode it records the Git commit and UTC timestamp while emitting JSON `null` for all unmeasured optional metrics. Missing evidence must never be represented as zero.

## Tauri experimental foundation comparison

- Commit measured: `3518a3eda2db4483fb07f7de532bf2ab35168eb2`
- Measured at: `2026-09-04T15:59:04.3460837+00:00`
- Command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/measure-desktop-baseline.ps1 -ExecutablePath <release-exe> -InstallerPath <nsis-setup> -RuntimePath <release-exe> -WarmupSeconds 3 -SampleSeconds 5`
- Package smoke: `npm run test:tauri-package` passed; the visible window appeared within 15 seconds, no forbidden service child was found, and `WM_CLOSE` produced exit code 0.

| Metric | Tauri foundation value | Scope |
| --- | ---: | --- |
| NSIS installer bytes | `7,496,717` | Installer containing only the Phase 0–1 foundation |
| Release executable bytes | `16,265,728` | Passed as the runtime artifact; not an installed directory |
| Process launch milliseconds | `116` | Time for `Start-Process` to return, not time-to-interactive |
| Idle process-tree working set bytes | `373,530,624` | Root plus WebView2 descendants after a 3-second warmup |
| Idle process-tree CPU percent | `0` | Five-second sample, rounded to two decimals |

These figures are not a product-level Electron-versus-Tauri comparison. The Tauri artifact does not yet include the existing workspace, voice, OBS, session, or resume-management features, while the legacy package metrics remain pending because no legacy installer/runtime was supplied during the original capture.
