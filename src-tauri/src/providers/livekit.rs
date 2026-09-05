use std::{fmt, time::Duration};

use livekit_api::access_token::{AccessToken, VideoGrants};
use reqwest::{StatusCode, Url, blocking::Client};
use serde::Deserialize;
use zeroize::Zeroizing;

use super::openai_compatible::{BoundedBodyError, build_bounded_client, read_bounded_body};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveKitError {
    EndpointInvalid,
    CredentialsMissing,
    ClientUnavailable,
    Timeout,
    Unauthorized,
    RequestFailed,
    ResponseTooLarge,
    ResponseInvalid,
    TokenFailed,
    RoomInvalid,
    IdentityInvalid,
}

impl LiveKitError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::EndpointInvalid => "LIVEKIT_ENDPOINT_INVALID",
            Self::CredentialsMissing => "LIVEKIT_CREDENTIALS_MISSING",
            Self::ClientUnavailable => "LIVEKIT_CLIENT_UNAVAILABLE",
            Self::Timeout => "LIVEKIT_TIMEOUT",
            Self::Unauthorized => "LIVEKIT_UNAUTHORIZED",
            Self::RequestFailed => "LIVEKIT_REQUEST_FAILED",
            Self::ResponseTooLarge => "LIVEKIT_RESPONSE_TOO_LARGE",
            Self::ResponseInvalid => "LIVEKIT_RESPONSE_INVALID",
            Self::TokenFailed => "LIVEKIT_TOKEN_FAILED",
            Self::RoomInvalid => "LIVEKIT_ROOM_INVALID",
            Self::IdentityInvalid => "LIVEKIT_IDENTITY_INVALID",
        }
    }
}

impl fmt::Display for LiveKitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for LiveKitError {}

pub trait LiveKitProbe: Send + Sync {
    fn test(&self, url: &str, api_key: &str, api_secret: &str) -> Result<(), LiveKitError>;
}

pub struct OfficialLiveKitProbe {
    client: Client,
}

impl OfficialLiveKitProbe {
    pub fn new() -> Result<Self, LiveKitError> {
        let client = build_bounded_client().map_err(|_| LiveKitError::ClientUnavailable)?;
        Ok(Self { client })
    }
}

impl LiveKitProbe for OfficialLiveKitProbe {
    fn test(&self, url: &str, api_key: &str, api_secret: &str) -> Result<(), LiveKitError> {
        if api_key.trim().is_empty() || api_secret.trim().is_empty() {
            return Err(LiveKitError::CredentialsMissing);
        }
        let request_url = control_url(url)?;
        let token = room_list_token(api_key, api_secret)?;
        let response = self
            .client
            .post(request_url)
            .header("Accept", "application/json")
            .bearer_auth(token.as_str())
            .json(&serde_json::json!({}))
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    LiveKitError::Timeout
                } else {
                    LiveKitError::RequestFailed
                }
            })?;
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            return Err(LiveKitError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(LiveKitError::RequestFailed);
        }
        let bytes = read_bounded_body(response).map_err(|error| match error {
            BoundedBodyError::TooLarge => LiveKitError::ResponseTooLarge,
            BoundedBodyError::Failed => LiveKitError::RequestFailed,
        })?;
        parse_list_rooms(&bytes)
    }
}

pub(crate) fn room_list_token(
    api_key: &str,
    api_secret: &str,
) -> Result<Zeroizing<String>, LiveKitError> {
    let jwt = AccessToken::with_api_key(api_key, api_secret)
        .with_ttl(Duration::from_secs(60))
        .with_grants(VideoGrants {
            room_list: true,
            room_create: false,
            room_admin: false,
            room_join: false,
            can_publish: false,
            can_subscribe: false,
            can_publish_data: false,
            ..VideoGrants::default()
        })
        .to_jwt()
        .map_err(|_| LiveKitError::TokenFailed)?;
    Ok(Zeroizing::new(jwt))
}

pub(crate) fn room_join_token(
    api_key: &str,
    api_secret: &str,
    room: &str,
    identity: &str,
) -> Result<Zeroizing<String>, LiveKitError> {
    let room = room.trim();
    let identity = identity.trim();
    if room.is_empty() {
        return Err(LiveKitError::RoomInvalid);
    }
    if identity.is_empty() {
        return Err(LiveKitError::IdentityInvalid);
    }
    let jwt = AccessToken::with_api_key(api_key, api_secret)
        .with_identity(identity)
        .with_ttl(Duration::from_secs(60))
        .with_grants(VideoGrants {
            room_join: true,
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
            room_list: false,
            room_create: false,
            room_admin: false,
            room: room.to_owned(),
            ..VideoGrants::default()
        })
        .to_jwt()
        .map_err(|_| LiveKitError::TokenFailed)?;
    Ok(Zeroizing::new(jwt))
}

pub(crate) fn control_url(raw: &str) -> Result<Url, LiveKitError> {
    let parsed = Url::parse(raw).map_err(|_| LiveKitError::EndpointInvalid)?;
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(LiveKitError::EndpointInvalid);
    }
    let scheme = match parsed.scheme() {
        "ws" => "http",
        "wss" => "https",
        _ => return Err(LiveKitError::EndpointInvalid),
    };
    let host = parsed.host_str().ok_or(LiveKitError::EndpointInvalid)?;
    let port = parsed
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Url::parse(&format!(
        "{scheme}://{host}{port}/twirp/livekit.RoomService/ListRooms"
    ))
    .map_err(|_| LiveKitError::EndpointInvalid)
}

#[derive(Deserialize)]
struct ListRoomsResponse {
    #[allow(dead_code)]
    rooms: Vec<serde_json::Value>,
}

fn parse_list_rooms(bytes: &[u8]) -> Result<(), LiveKitError> {
    let _: ListRoomsResponse =
        serde_json::from_slice(bytes).map_err(|_| LiveKitError::ResponseInvalid)?;
    Ok(())
}
