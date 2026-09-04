import { invoke } from "@tauri-apps/api/core";

import type { CommandResult, FoundationStatus, SecretStatus } from "../generated/bindings";

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
