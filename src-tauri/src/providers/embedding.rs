use std::fmt;

use reqwest::{StatusCode, Url, blocking::Client};
use serde::Deserialize;
use serde_json::json;

use super::{
    ProviderEndpoint,
    openai_compatible::{BoundedBodyError, build_bounded_client, read_bounded_body},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingError {
    EndpointInvalid,
    ClientUnavailable,
    Timeout,
    Unauthorized,
    RequestFailed,
    ResponseTooLarge,
    ResponseInvalid,
    NonFiniteValue,
    DimensionMismatch,
}

impl EmbeddingError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::EndpointInvalid => "EMBEDDING_ENDPOINT_INVALID",
            Self::ClientUnavailable => "EMBEDDING_CLIENT_UNAVAILABLE",
            Self::Timeout => "EMBEDDING_TIMEOUT",
            Self::Unauthorized => "EMBEDDING_UNAUTHORIZED",
            Self::RequestFailed => "EMBEDDING_REQUEST_FAILED",
            Self::ResponseTooLarge => "EMBEDDING_RESPONSE_TOO_LARGE",
            Self::ResponseInvalid => "EMBEDDING_RESPONSE_INVALID",
            Self::NonFiniteValue => "EMBEDDING_NON_FINITE_VALUE",
            Self::DimensionMismatch => "EMBEDDING_DIMENSION_MISMATCH",
        }
    }
}

impl fmt::Display for EmbeddingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for EmbeddingError {}

pub trait EmbeddingProbe: Send + Sync {
    fn embed(
        &self,
        endpoint: &ProviderEndpoint,
        credential: Option<&str>,
        model_id: &str,
        dimensions: u32,
        input: &str,
    ) -> Result<Vec<f32>, EmbeddingError>;
}

pub struct OpenAiCompatibleEmbeddingProbe {
    client: Client,
}

impl OpenAiCompatibleEmbeddingProbe {
    pub fn new() -> Result<Self, EmbeddingError> {
        let client = build_bounded_client().map_err(|_| EmbeddingError::ClientUnavailable)?;
        Ok(Self { client })
    }
}

impl EmbeddingProbe for OpenAiCompatibleEmbeddingProbe {
    fn embed(
        &self,
        endpoint: &ProviderEndpoint,
        credential: Option<&str>,
        model_id: &str,
        dimensions: u32,
        input: &str,
    ) -> Result<Vec<f32>, EmbeddingError> {
        let url = normalize_embeddings_url(&endpoint.base_url)?;
        let mut request = self
            .client
            .post(url)
            .header("Accept", "application/json")
            .json(&json!({
                "input": input,
                "model": model_id,
                "dimensions": dimensions,
                "encoding_format": "float",
            }));
        if let Some(credential) = credential.filter(|value| !value.is_empty()) {
            request = request.bearer_auth(credential);
        }
        let response = request.send().map_err(|error| {
            if error.is_timeout() {
                EmbeddingError::Timeout
            } else {
                EmbeddingError::RequestFailed
            }
        })?;
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            return Err(EmbeddingError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(EmbeddingError::RequestFailed);
        }
        let bytes = read_bounded_body(response).map_err(|error| match error {
            BoundedBodyError::TooLarge => EmbeddingError::ResponseTooLarge,
            BoundedBodyError::Failed => EmbeddingError::RequestFailed,
        })?;
        parse_embedding_vector(&bytes, dimensions)
    }
}

fn normalize_embeddings_url(base_url: &str) -> Result<Url, EmbeddingError> {
    let url = Url::parse(base_url).map_err(|_| EmbeddingError::EndpointInvalid)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(EmbeddingError::EndpointInvalid);
    }
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/embeddings") {
        path.to_owned()
    } else if path.is_empty() {
        "/embeddings".to_owned()
    } else {
        format!("{path}/embeddings")
    };
    let mut url = url;
    url.set_path(&path);
    Ok(url)
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingEntry>,
}

#[derive(Deserialize)]
struct EmbeddingEntry {
    embedding: Vec<f64>,
}

fn parse_embedding_vector(bytes: &[u8], dimensions: u32) -> Result<Vec<f32>, EmbeddingError> {
    let response: EmbeddingResponse =
        serde_json::from_slice(bytes).map_err(|_| EmbeddingError::ResponseInvalid)?;
    let values = response
        .data
        .into_iter()
        .next()
        .ok_or(EmbeddingError::ResponseInvalid)?
        .embedding;
    if values.len() as u32 != dimensions {
        return Err(EmbeddingError::DimensionMismatch);
    }
    let mut vector = Vec::with_capacity(values.len());
    for value in values {
        let value = value as f32;
        if !value.is_finite() {
            return Err(EmbeddingError::NonFiniteValue);
        }
        vector.push(value);
    }
    Ok(vector)
}
