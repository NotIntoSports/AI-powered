import { invoke } from "@tauri-apps/api/core";

import type { CommandResult, DiagnosticsExportResult, FoundationStatus, ModelDiscoveryResult, ProviderConfig, ProviderSaveInput, ProviderTestResult, PublicConfig, StartupState, VoiceRouteConfig, VoiceRouteSaveInput, VoiceRouteTestResult } from "../generated/bindings";

export function getFoundationStatus() {
  return invoke<CommandResult<FoundationStatus>>("foundation_get_status");
}

export function exportDiagnostics(destination: string) {
  return invoke<CommandResult<DiagnosticsExportResult>>("diagnostics_export", { destination });
}

export function getStartupState() {
  return invoke<CommandResult<StartupState>>("config_get_startup_state");
}

export function getConfigPublic() {
  return invoke<CommandResult<PublicConfig>>("config_get_public");
}

export function saveModelProvider(input: ProviderSaveInput) {
  return invoke<CommandResult<ProviderConfig>>("model_provider_save", { input });
}

export function testModelProvider(providerId: string) {
  return invoke<CommandResult<ProviderTestResult>>("model_provider_test", { providerId });
}

export function discoverModelProvider(providerId: string) {
  return invoke<CommandResult<ModelDiscoveryResult>>("model_provider_discover", { providerId });
}

export function activateModelProvider(providerId: string) {
  return invoke<CommandResult<ProviderConfig>>("model_provider_activate", { providerId });
}

export function deleteModelProvider(providerId: string) {
  return invoke<CommandResult<FoundationStatus>>("model_provider_delete", { providerId });
}

export function saveSpeechRoute(input: VoiceRouteSaveInput) {
  return invoke<CommandResult<VoiceRouteConfig>>("speech_route_save", { input });
}

export function testSpeechRoute(routeId: string) {
  return invoke<CommandResult<VoiceRouteTestResult>>("speech_route_test", { routeId });
}

export function activateSpeechRoute(routeId: string) {
  return invoke<CommandResult<VoiceRouteConfig>>("speech_route_activate", { routeId });
}

export function deleteSpeechRoute(routeId: string) {
  return invoke<CommandResult<FoundationStatus>>("speech_route_delete", { routeId });
}

export function restoreLastGoodConfig() {
  return invoke<CommandResult<StartupState>>("config_restore_last_good");
}

export function restoreDefaultConfig() {
  return invoke<CommandResult<StartupState>>("config_restore_defaults");
}

export function openAppDirectory(kind: "config" | "data") {
  return invoke<CommandResult<FoundationStatus>>("open_app_directory", { kind });
}
