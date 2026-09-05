mod embeddings;
mod livekit;
mod materials;
mod providers;
mod roles;
mod sessions;
mod voice_routes;

pub use embeddings::{
    EmbeddingConfigSaveInput, EmbeddingService, EmbeddingServiceError, EmbeddingTestResult,
};
pub use livekit::{
    LiveKitSettingsError, LiveKitSettingsSaveInput, LiveKitSettingsService, LiveKitTestResult,
};
pub use materials::{
    EmbeddingSpace, MaterialSearchHit, MaterialService, MaterialServiceError, MaterialSummary,
};
pub use providers::{
    DiscoveredModelDto, ModelDiscoveryResult, ProviderSaveInput, ProviderService,
    ProviderServiceError, ProviderTestResult,
};
pub use roles::{
    RoleProfileCopyInput, RoleProfileSaveInput, RoleProfileService, RoleProfileServiceError,
};
pub use sessions::{
    SessionControl, SessionProbes, SessionService, SessionServiceError, SessionStartOutcome,
};
pub use voice_routes::{
    VoiceRouteSaveInput, VoiceRouteService, VoiceRouteServiceError, VoiceRouteTestResult,
};

#[cfg(test)]
mod tests;
