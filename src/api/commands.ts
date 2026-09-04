import { invoke } from "@tauri-apps/api/core";

import type { CommandResult, DiagnosticsExportResult, FoundationStatus, SecretStatus, StartupState } from "../generated/bindings";

export function getFoundationStatus() {
  return invoke<CommandResult<FoundationStatus>>("foundation_get_status");
}

export function setSecret(reference: string, value: string) {
  return invoke<CommandResult<SecretStatus>>("secret_set", { reference, value });
}

export function deleteSecret(reference: string) {
  return invoke<CommandResult<SecretStatus>>("secret_delete", { reference });
}

export function getSecretStatuses(references: string[]) {
  return invoke<CommandResult<SecretStatus[]>>("secret_status", { references });
}

export function exportDiagnostics(destination: string) {
  return invoke<CommandResult<DiagnosticsExportResult>>("diagnostics_export", { destination });
}

export function getStartupState() {
  return invoke<CommandResult<StartupState>>("config_get_startup_state");
}

export function restoreLastGoodConfig() {
  return invoke<CommandResult<StartupState>>("config_restore_last_good");
}

export function restoreDefaultConfig() {
  return invoke<CommandResult<StartupState>>("config_restore_defaults");
}
