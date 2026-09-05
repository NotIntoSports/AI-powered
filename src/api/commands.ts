import { invoke } from "@tauri-apps/api/core";

import type { CommandResult, DiagnosticsExportResult, EmbeddingConfig, EmbeddingConfigSaveInput, EmbeddingTestResult, FoundationStatus, LiveKitConfig, LiveKitSettingsSaveInput, LiveKitTestResult, MaterialSearchHit, MaterialSummary, ModelDiscoveryResult, ProviderConfig, ProviderSaveInput, ProviderTestResult, PublicConfig, RoleProfileConfig, RoleProfileCopyInput, RoleProfileSaveInput, StartupState, VoiceRouteConfig, VoiceRouteSaveInput, VoiceRouteTestResult } from "../generated/bindings";

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

export function saveRoleProfile(input: RoleProfileSaveInput) {
  return invoke<CommandResult<RoleProfileConfig>>("role_profile_save", { input });
}

export function copyRoleProfile(input: RoleProfileCopyInput) {
  return invoke<CommandResult<RoleProfileConfig>>("role_profile_copy", { input });
}

export function activateRoleProfile(roleId: string) {
  return invoke<CommandResult<RoleProfileConfig>>("role_profile_activate", { roleId });
}

export function deleteRoleProfile(roleId: string) {
  return invoke<CommandResult<FoundationStatus>>("role_profile_delete", { roleId });
}

export function saveEmbeddingConfig(input: EmbeddingConfigSaveInput) {
  return invoke<CommandResult<EmbeddingConfig>>("embedding_config_save", { input });
}

export function testEmbeddingConfig(embeddingId: string) {
  return invoke<CommandResult<EmbeddingTestResult>>("embedding_config_test", { embeddingId });
}

export function activateEmbeddingConfig(embeddingId: string) {
  return invoke<CommandResult<EmbeddingConfig>>("embedding_config_activate", { embeddingId });
}

export function deleteEmbeddingConfig(embeddingId: string) {
  return invoke<CommandResult<FoundationStatus>>("embedding_config_delete", { embeddingId });
}

export function saveLiveKitSettings(input: LiveKitSettingsSaveInput) {
  return invoke<CommandResult<LiveKitConfig>>("livekit_settings_save", { input });
}

export function testLiveKitSettings() {
  return invoke<CommandResult<LiveKitTestResult>>("livekit_settings_test");
}

export function enableLiveKitSettings(enabled: boolean) {
  return invoke<CommandResult<LiveKitConfig>>("livekit_settings_enable", { enabled });
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

export function listMaterials() {
  return invoke<CommandResult<MaterialSummary[]>>("material_list");
}

export function importMaterial(path: string) {
  return invoke<CommandResult<MaterialSummary>>("material_import", { path });
}

export function searchMaterials(query: string, topK?: number) {
  return invoke<CommandResult<MaterialSearchHit[]>>("material_search", { query, topK });
}

export function deleteMaterial(id: string) {
  return invoke<CommandResult<FoundationStatus>>("material_delete", { id });
}
