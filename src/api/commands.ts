import { invoke } from "@tauri-apps/api/core";

import type { CommandResult, FoundationStatus } from "../generated/bindings";

export function getFoundationStatus() {
  return invoke<CommandResult<FoundationStatus>>("foundation_get_status");
}
