mod embeddings;
mod livekit;
mod providers;
mod roles;
mod voice_routes;

pub use embeddings::{
    EmbeddingConfigSaveInput, EmbeddingService, EmbeddingServiceError, EmbeddingTestResult,
};
pub use livekit::{
    LiveKitSettingsError, LiveKitSettingsSaveInput, LiveKitSettingsService, LiveKitTestResult,
};
pub use providers::{
    DiscoveredModelDto, ModelDiscoveryResult, ProviderSaveInput, ProviderService,
    ProviderServiceError, ProviderTestResult,
};
pub use roles::{
    RoleProfileCopyInput, RoleProfileSaveInput, RoleProfileService, RoleProfileServiceError,
};
pub use voice_routes::{
    VoiceRouteSaveInput, VoiceRouteService, VoiceRouteServiceError, VoiceRouteTestResult,
};

#[cfg(test)]
mod tests;
