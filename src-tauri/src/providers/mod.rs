mod cascade;
mod embedding;
mod livekit;
mod openai_compatible;
mod openai_realtime;

use std::fmt;

pub use cascade::{
    CascadeError, CascadeStage, ChatMessage, ChatModel, OpenAiCompatibleCascade, SpeechToText,
    TextToSpeech,
};
#[cfg(test)]
pub(crate) use cascade::{
    build_asr_multipart, build_llm_request, build_tts_request, json_body_too_large,
    normalize_chat_completions_url, normalize_speech_url, normalize_transcriptions_url,
    parse_chat_completion, parse_transcript, parse_tts_pcm, pcm_to_wav, tts_body_too_large,
};
pub use embedding::{EmbeddingError, EmbeddingProbe, OpenAiCompatibleEmbeddingProbe};
pub(crate) use livekit::room_join_token;
pub use livekit::{LiveKitError, LiveKitProbe, OfficialLiveKitProbe};
#[cfg(test)]
pub(crate) use livekit::{control_url, room_list_token};
pub use openai_compatible::OpenAiCompatibleProbe;
#[cfg(test)]
pub(crate) use openai_compatible::{normalize_models_url, parse_model_catalog};
#[cfg(test)]
pub(crate) use openai_realtime::{
    InputTranscriptAssembler, RealtimeDialectName, RealtimeTransport, realtime_dialect,
    realtime_url, session_update_event, wait_session_updated,
};
pub use openai_realtime::{
    OpenAiCompatibleRealtime, RealtimeError, RealtimeModel, RealtimeTextRequest, RealtimeTurn,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEndpoint {
    pub provider_id: String,
    pub base_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderError {
    EndpointInvalid,
    ClientUnavailable,
    Timeout,
    Unauthorized,
    RequestFailed,
    ResponseTooLarge,
    ResponseInvalid,
}

impl ProviderError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::EndpointInvalid => "PROVIDER_ENDPOINT_INVALID",
            Self::ClientUnavailable => "PROVIDER_CLIENT_UNAVAILABLE",
            Self::Timeout => "PROVIDER_TIMEOUT",
            Self::Unauthorized => "PROVIDER_UNAUTHORIZED",
            Self::RequestFailed => "PROVIDER_REQUEST_FAILED",
            Self::ResponseTooLarge => "PROVIDER_RESPONSE_TOO_LARGE",
            Self::ResponseInvalid => "PROVIDER_RESPONSE_INVALID",
        }
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ProviderError {}

pub trait ProviderProbe: Send + Sync {
    fn discover_models(
        &self,
        endpoint: &ProviderEndpoint,
        credential: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, ProviderError>;
}

#[cfg(test)]
mod tests;
