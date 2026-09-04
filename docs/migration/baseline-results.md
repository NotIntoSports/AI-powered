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
