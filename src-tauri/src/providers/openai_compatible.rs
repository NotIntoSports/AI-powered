use std::{io::Read, time::Duration};

use reqwest::{StatusCode, Url, blocking::Client, redirect::Policy};
use serde::Deserialize;

use super::{DiscoveredModel, ProviderEndpoint, ProviderError, ProviderProbe};

pub(crate) const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

fn build_client(timeout: Duration) -> Result<Client, reqwest::Error> {
    Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(5))
        .redirect(Policy::none())
        .no_proxy()
        .tls_backend_rustls()
        .build()
}

pub(crate) fn build_bounded_client() -> Result<Client, reqwest::Error> {
    build_client(Duration::from_secs(10))
}

pub(crate) fn build_cascade_client() -> Result<Client, reqwest::Error> {
    build_client(Duration::from_secs(30))
}

pub(crate) enum BoundedBodyError {
    TooLarge,
    Failed,
}

pub(crate) fn read_bounded_body(
    response: reqwest::blocking::Response,
) -> Result<Vec<u8>, BoundedBodyError> {
    read_bounded_body_limited(response, MAX_RESPONSE_BYTES)
}

pub(crate) fn read_bounded_body_limited(
    response: reqwest::blocking::Response,
    max_bytes: u64,
) -> Result<Vec<u8>, BoundedBodyError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(BoundedBodyError::TooLarge);
    }
    let mut bytes = Vec::new();
    response
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| BoundedBodyError::Failed)?;
    if bytes.len() as u64 > max_bytes {
        return Err(BoundedBodyError::TooLarge);
    }
    Ok(bytes)
}

pub struct OpenAiCompatibleProbe {
    client: Client,
}

impl OpenAiCompatibleProbe {
    pub fn new() -> Result<Self, ProviderError> {
        let client = build_bounded_client().map_err(|_| ProviderError::ClientUnavailable)?;
        Ok(Self { client })
    }
}

impl ProviderProbe for OpenAiCompatibleProbe {
    fn discover_models(
        &self,
        endpoint: &ProviderEndpoint,
        credential: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, ProviderError> {
        let url = normalize_models_url(&endpoint.base_url)?;
        let mut request = self.client.get(url).header("Accept", "application/json");
        if let Some(credential) = credential.filter(|value| !value.is_empty()) {
            request = request.bearer_auth(credential);
        }
        let response = request.send().map_err(|error| {
            if error.is_timeout() {
                ProviderError::Timeout
            } else {
                ProviderError::RequestFailed
            }
        })?;
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            return Err(ProviderError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(ProviderError::RequestFailed);
        }
        let bytes = read_bounded_body(response).map_err(|error| match error {
            BoundedBodyError::TooLarge => ProviderError::ResponseTooLarge,
            BoundedBodyError::Failed => ProviderError::RequestFailed,
        })?;
        parse_model_catalog(&bytes)
    }
}

pub(crate) fn normalize_models_url(base_url: &str) -> Result<Url, ProviderError> {
    let mut url = Url::parse(base_url).map_err(|_| ProviderError::EndpointInvalid)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(ProviderError::EndpointInvalid);
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/models") {
        path.to_owned()
    } else if path.is_empty() {
        "/models".to_owned()
    } else {
        format!("{path}/models")
    };
    url.set_path(&path);
    Ok(url)
}

#[derive(Deserialize)]
struct ModelCatalog {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

pub(crate) fn parse_model_catalog(bytes: &[u8]) -> Result<Vec<DiscoveredModel>, ProviderError> {
    let catalog: ModelCatalog =
        serde_json::from_slice(bytes).map_err(|_| ProviderError::ResponseInvalid)?;
    let mut ids = catalog
        .data
        .into_iter()
        .map(|entry| entry.id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    Ok(ids.into_iter().map(|id| DiscoveredModel { id }).collect())
}
