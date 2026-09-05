mod embedding;
mod openai_compatible;

use std::fmt;

pub use embedding::{EmbeddingError, EmbeddingProbe, OpenAiCompatibleEmbeddingProbe};
pub use openai_compatible::OpenAiCompatibleProbe;
#[cfg(test)]
pub(crate) use openai_compatible::{normalize_models_url, parse_model_catalog};

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
