use std::{io::Read, time::Duration};

use reqwest::{StatusCode, Url, blocking::Client, redirect::Policy};
use serde::Deserialize;

use super::{DiscoveredModel, ProviderEndpoint, ProviderError, ProviderProbe};

const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

pub struct OpenAiCompatibleProbe {
    client: Client,
}

impl OpenAiCompatibleProbe {
    pub fn new() -> Result<Self, ProviderError> {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .redirect(Policy::none())
            .no_proxy()
            .tls_backend_rustls()
            .build()
            .map_err(|_| ProviderError::ClientUnavailable)?;
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
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES)
        {
            return Err(ProviderError::ResponseTooLarge);
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ProviderError::RequestFailed)?;
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(ProviderError::ResponseTooLarge);
        }
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
