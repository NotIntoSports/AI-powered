use std::{
    collections::{HashMap, HashSet},
    fmt,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::Url;
use serde_json::{Value, json};
use tungstenite::{
    ClientRequestBuilder, Error as WsError, HandshakeError, Message, client::IntoClientRequest,
    protocol::WebSocketConfig, stream::MaybeTlsStream,
};

use super::ProviderEndpoint;

pub const ALIYUN_REALTIME_PATH: &str = "/api-ws/v1/realtime";
pub const CONNECT_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
pub const SESSION_UPDATED_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_TEXT_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeDialectName {
    Openai,
    Aliyun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealtimeDialect {
    pub name: RealtimeDialectName,
    pub audio_format: &'static str,
    pub default_voice: Option<&'static str>,
}

const OPENAI_DIALECT: RealtimeDialect = RealtimeDialect {
    name: RealtimeDialectName::Openai,
    audio_format: "pcm16",
    default_voice: Some("alloy"),
};

const ALIYUN_DIALECT: RealtimeDialect = RealtimeDialect {
    name: RealtimeDialectName::Aliyun,
    audio_format: "pcm",
    default_voice: None,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RealtimeError {
    UrlInvalid,
    ConnectFailed,
    Timeout,
    SessionUpdateTimeout,
    SessionUpdateUnexpected,
    EventInvalid,
    AudioInvalid,
    Unauthorized,
    ResponseTooLarge,
    Cancelled,
    TextEmpty,
    Remote(String),
}

impl RealtimeError {
    pub fn code(&self) -> &str {
        match self {
            Self::UrlInvalid => "REALTIME_URL_INVALID",
            Self::ConnectFailed => "REALTIME_CONNECT_FAILED",
            Self::Timeout => "REALTIME_TIMEOUT",
            Self::SessionUpdateTimeout => "REALTIME_SESSION_UPDATE_TIMEOUT",
            Self::SessionUpdateUnexpected => "REALTIME_SESSION_UPDATE_UNEXPECTED",
            Self::EventInvalid => "REALTIME_EVENT_INVALID",
            Self::AudioInvalid => "REALTIME_AUDIO_INVALID",
            Self::Unauthorized => "REALTIME_UNAUTHORIZED",
            Self::ResponseTooLarge => "REALTIME_RESPONSE_TOO_LARGE",
            Self::Cancelled => "SESSION_CANCELLED",
            Self::TextEmpty => "REALTIME_TEXT_EMPTY",
            Self::Remote(code) => code,
        }
    }
}

impl fmt::Display for RealtimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for RealtimeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeTurn {
    pub user_text: String,
    pub assistant_text: String,
    pub tts_pcm: Vec<u8>,
}

pub struct RealtimeTextRequest<'a> {
    pub endpoint: &'a ProviderEndpoint,
    pub credential: Option<&'a str>,
    pub model_id: &'a str,
    pub instructions: &'a str,
    pub prompt: &'a str,
    pub include_audio: bool,
}

pub trait RealtimeModel: Send + Sync {
    fn transcribe_turn(
        &self,
        endpoint: &ProviderEndpoint,
        credential: Option<&str>,
        model_id: &str,
        pcm16le: &[u8],
        sample_rate: u32,
        cancel: &AtomicBool,
    ) -> Result<RealtimeTurn, RealtimeError>;

    fn text_turn(
        &self,
        request: RealtimeTextRequest<'_>,
        cancel: &AtomicBool,
    ) -> Result<RealtimeTurn, RealtimeError> {
        let _ = (request, cancel);
        Err(RealtimeError::TextEmpty)
    }
}

pub trait RealtimeTransport {
    fn recv_text(&mut self, timeout: Duration) -> Result<String, RealtimeError>;
}

pub struct OpenAiCompatibleRealtime;

impl OpenAiCompatibleRealtime {
    pub fn new() -> Self {
        Self
    }
}

impl Default for OpenAiCompatibleRealtime {
    fn default() -> Self {
        Self::new()
    }
}

impl RealtimeModel for OpenAiCompatibleRealtime {
    fn transcribe_turn(
        &self,
        endpoint: &ProviderEndpoint,
        credential: Option<&str>,
        model_id: &str,
        pcm16le: &[u8],
        sample_rate: u32,
        cancel: &AtomicBool,
    ) -> Result<RealtimeTurn, RealtimeError> {
        let _ = sample_rate;
        if cancel.load(Ordering::Relaxed) {
            return Err(RealtimeError::Cancelled);
        }
        let url = realtime_url(&endpoint.base_url, model_id)?;
        let dialect = realtime_dialect(&endpoint.base_url);
        let mut socket = connect_realtime(&url, credential)?;
        let update = session_update_event("", "", &dialect);
        send_text(&mut socket, &update.to_string())?;
        wait_session_updated(&mut socket, SESSION_UPDATED_TIMEOUT)?;
        if cancel.load(Ordering::Relaxed) {
            return Err(RealtimeError::Cancelled);
        }
        send_text(&mut socket, &append_audio_event(pcm16le))?;
        send_text(&mut socket, r#"{"type":"input_audio_buffer.commit"}"#)?;
        collect_turn(&mut socket, cancel)
    }

    fn text_turn(
        &self,
        request: RealtimeTextRequest<'_>,
        cancel: &AtomicBool,
    ) -> Result<RealtimeTurn, RealtimeError> {
        if cancel.load(Ordering::Relaxed) {
            return Err(RealtimeError::Cancelled);
        }
        let url = realtime_url(&request.endpoint.base_url, request.model_id)?;
        let dialect = realtime_dialect(&request.endpoint.base_url);
        let mut socket = connect_realtime(&url, request.credential)?;
        let modalities = if request.include_audio {
            json!(["text", "audio"])
        } else {
            json!(["text"])
        };
        let mut session = json!({
            "modalities": modalities,
            "instructions": request.instructions,
            "input_audio_format": dialect.audio_format,
            "output_audio_format": dialect.audio_format,
        });
        let voice = dialect.default_voice.unwrap_or("");
        if !voice.is_empty() {
            session["voice"] = json!(voice);
        }
        send_text(
            &mut socket,
            &json!({ "type": "session.update", "session": session }).to_string(),
        )?;
        wait_session_updated(&mut socket, SESSION_UPDATED_TIMEOUT)?;
        if cancel.load(Ordering::Relaxed) {
            return Err(RealtimeError::Cancelled);
        }
        send_text(&mut socket, &conversation_text_event(request.prompt))?;
        send_text(&mut socket, &response_create_event(request.include_audio))?;
        collect_turn(&mut socket, cancel)
    }
}

pub struct InputTranscriptAssembler {
    texts: HashMap<String, String>,
    finalized: HashSet<String>,
}

impl InputTranscriptAssembler {
    pub fn new() -> Self {
        Self {
            texts: HashMap::new(),
            finalized: HashSet::new(),
        }
    }

    pub fn update(&mut self, kind: &str, payload: &Value) -> Option<(String, String, bool)> {
        let item_id = payload
            .get("item_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        if item_id.is_empty() || self.finalized.contains(&item_id) {
            return None;
        }
        if kind == "input_transcript_completed" {
            let transcript = payload
                .get("transcript")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned();
            if transcript.is_empty() {
                return None;
            }
            self.texts.insert(item_id.clone(), transcript.clone());
            self.finalized.insert(item_id.clone());
            return Some((item_id, transcript, true));
        }
        if kind != "input_transcript_delta" {
            return None;
        }
        let stable = payload.get("text").and_then(Value::as_str).unwrap_or("");
        let stash = payload.get("stash").and_then(Value::as_str).unwrap_or("");
        let delta = payload.get("delta").and_then(Value::as_str).unwrap_or("");
        let text = if !stable.is_empty() || !stash.is_empty() {
            format!("{stable}{stash}")
        } else {
            format!(
                "{}{delta}",
                self.texts.get(&item_id).map(String::as_str).unwrap_or("")
            )
        };
        let text = text.trim().to_owned();
        if text.is_empty() {
            return None;
        }
        self.texts.insert(item_id.clone(), text.clone());
        Some((item_id, text, false))
    }
}

pub fn realtime_dialect(base_url: &str) -> RealtimeDialect {
    let Ok(parsed) = Url::parse(base_url.trim()) else {
        return OPENAI_DIALECT;
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let path = parsed.path().to_ascii_lowercase();
    let is_aliyun = path.contains("compatible-mode")
        || path.trim_end_matches('/').ends_with(ALIYUN_REALTIME_PATH)
        || host.contains("dashscope")
        || host.contains("token-plan");
    if is_aliyun {
        ALIYUN_DIALECT
    } else {
        OPENAI_DIALECT
    }
}

pub fn realtime_url(base_url: &str, model: &str) -> Result<Url, RealtimeError> {
    let raw = base_url.trim().trim_end_matches('/');
    let mut url = Url::parse(raw).map_err(|_| RealtimeError::UrlInvalid)?;
    if !matches!(url.scheme(), "http" | "https" | "ws" | "wss")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(RealtimeError::UrlInvalid);
    }
    let dialect = realtime_dialect(raw);
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        _ => return Err(RealtimeError::UrlInvalid),
    };
    url.set_scheme(scheme)
        .map_err(|_| RealtimeError::UrlInvalid)?;
    let path = if dialect.name == RealtimeDialectName::Aliyun {
        ALIYUN_REALTIME_PATH.to_owned()
    } else {
        let path = url.path().trim_end_matches('/');
        if path.ends_with("/realtime") {
            path.to_owned()
        } else if path.is_empty() {
            "/realtime".to_owned()
        } else {
            format!("{path}/realtime")
        }
    };
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut().append_pair("model", model);
    Ok(url)
}

pub fn session_update_event(voice: &str, instructions: &str, dialect: &RealtimeDialect) -> Value {
    let mut session = json!({
        "modalities": ["text", "audio"],
        "instructions": instructions,
        "input_audio_format": dialect.audio_format,
        "output_audio_format": dialect.audio_format,
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "silence_duration_ms": 800,
            "create_response": true,
        },
    });
    let selected_voice = if voice.is_empty() {
        dialect.default_voice.unwrap_or("")
    } else {
        voice
    };
    if !selected_voice.is_empty() {
        session["voice"] = json!(selected_voice);
    }
    json!({
        "type": "session.update",
        "session": session,
    })
}

pub fn wait_session_updated<T: RealtimeTransport + ?Sized>(
    socket: &mut T,
    timeout: Duration,
) -> Result<(), RealtimeError> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(RealtimeError::SessionUpdateTimeout);
        }
        let raw = match socket.recv_text(remaining) {
            Ok(text) => text,
            Err(RealtimeError::Timeout | RealtimeError::SessionUpdateTimeout) => {
                return Err(RealtimeError::SessionUpdateTimeout);
            }
            Err(error) => return Err(error),
        };
        match parse_server_event(&raw)? {
            Some(ServerEvent::SessionCreated) | None => {}
            Some(ServerEvent::SessionUpdated) => return Ok(()),
            Some(_) => return Err(RealtimeError::SessionUpdateUnexpected),
        }
    }
}

fn append_audio_event(pcm: &[u8]) -> String {
    json!({
        "type": "input_audio_buffer.append",
        "audio": STANDARD.encode(pcm),
    })
    .to_string()
}

fn conversation_text_event(text: &str) -> String {
    json!({
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": text }],
        },
    })
    .to_string()
}

fn response_create_event(include_audio: bool) -> String {
    let modalities = if include_audio {
        json!(["text", "audio"])
    } else {
        json!(["text"])
    };
    json!({
        "type": "response.create",
        "response": { "modalities": modalities },
    })
    .to_string()
}

fn sanitize_remote_code(code: &str) -> String {
    let trimmed = code.trim();
    let mut sanitized = trimmed.chars().take(80).collect::<String>();
    if sanitized.is_empty() {
        sanitized = "REALTIME_REMOTE_ERROR".to_owned();
    }
    sanitized
}

enum ServerEvent {
    SessionCreated,
    SessionUpdated,
    ResponseDone,
    Audio(Vec<u8>),
    OutputTranscript(String),
    OutputText(String),
    InputTranscriptDelta(Value),
    InputTranscriptCompleted(Value),
}

fn parse_server_event(raw: &str) -> Result<Option<ServerEvent>, RealtimeError> {
    if raw.len() > MAX_TEXT_FRAME_BYTES {
        return Err(RealtimeError::ResponseTooLarge);
    }
    let event: Value = serde_json::from_str(raw).map_err(|_| RealtimeError::EventInvalid)?;
    let Some(kind) = event.get("type").and_then(Value::as_str) else {
        return Ok(None);
    };
    match kind {
        "response.audio.delta" => {
            let Some(delta) = event.get("delta").and_then(Value::as_str) else {
                return Ok(None);
            };
            let pcm = STANDARD
                .decode(delta)
                .map_err(|_| RealtimeError::AudioInvalid)?;
            Ok(Some(ServerEvent::Audio(pcm)))
        }
        "response.audio_transcript.delta" => Ok(event
            .get("delta")
            .and_then(Value::as_str)
            .map(|delta| ServerEvent::OutputTranscript(delta.to_owned()))),
        "response.text.delta" => Ok(event
            .get("delta")
            .and_then(Value::as_str)
            .map(|delta| ServerEvent::OutputText(delta.to_owned()))),
        "conversation.item.input_audio_transcription.delta" => {
            Ok(Some(ServerEvent::InputTranscriptDelta(json!({
                "item_id": event.get("item_id").and_then(Value::as_str).unwrap_or(""),
                "delta": event.get("delta").and_then(Value::as_str).unwrap_or(""),
                "text": event.get("text").and_then(Value::as_str).unwrap_or(""),
                "stash": event.get("stash").and_then(Value::as_str).unwrap_or(""),
            }))))
        }
        "conversation.item.input_audio_transcription.completed" => {
            let Some(transcript) = event.get("transcript").and_then(Value::as_str) else {
                return Ok(None);
            };
            Ok(Some(ServerEvent::InputTranscriptCompleted(json!({
                "item_id": event.get("item_id").and_then(Value::as_str).unwrap_or(""),
                "transcript": transcript,
            }))))
        }
        "response.done" => Ok(Some(ServerEvent::ResponseDone)),
        "session.updated" => Ok(Some(ServerEvent::SessionUpdated)),
        "session.created" => Ok(Some(ServerEvent::SessionCreated)),
        "error" => {
            let error = event.get("error");
            let code = error
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("REALTIME_REMOTE_ERROR");
            Err(RealtimeError::Remote(sanitize_remote_code(code)))
        }
        _ => Ok(None),
    }
}

struct TungsteniteSocket {
    socket: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
}

impl RealtimeTransport for TungsteniteSocket {
    fn recv_text(&mut self, timeout: Duration) -> Result<String, RealtimeError> {
        set_socket_timeouts(&mut self.socket, timeout)?;
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    if text.len() > MAX_TEXT_FRAME_BYTES {
                        return Err(RealtimeError::ResponseTooLarge);
                    }
                    return Ok(text.to_string());
                }
                Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => {}
                Ok(Message::Binary(_) | Message::Close(_)) => continue,
                Err(WsError::Io(error))
                    if error.kind() == std::io::ErrorKind::TimedOut
                        || error.kind() == std::io::ErrorKind::WouldBlock =>
                {
                    return Err(RealtimeError::Timeout);
                }
                Err(_) => return Err(RealtimeError::ConnectFailed),
            }
        }
    }
}

fn connect_realtime(
    url: &Url,
    credential: Option<&str>,
) -> Result<TungsteniteSocket, RealtimeError> {
    let host = url.host_str().ok_or(RealtimeError::UrlInvalid)?;
    let port = url
        .port_or_known_default()
        .ok_or(RealtimeError::UrlInvalid)?;
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|_| RealtimeError::ConnectFailed)?
        .next()
        .ok_or(RealtimeError::ConnectFailed)?;
    let stream = TcpStream::connect_timeout(&addr, CONNECT_OPEN_TIMEOUT).map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            RealtimeError::Timeout
        } else {
            RealtimeError::ConnectFailed
        }
    })?;
    let _ = stream.set_nodelay(true);
    set_tcp_timeouts(&stream, CONNECT_OPEN_TIMEOUT)?;
    let mut builder = ClientRequestBuilder::new(
        url.as_str()
            .parse()
            .map_err(|_| RealtimeError::UrlInvalid)?,
    )
    .with_header("OpenAI-Beta", "realtime=v1");
    if let Some(credential) = credential.filter(|value| !value.is_empty()) {
        builder = builder.with_header("Authorization", format!("Bearer {credential}"));
    }
    let request = builder
        .into_client_request()
        .map_err(|_| RealtimeError::UrlInvalid)?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_TEXT_FRAME_BYTES))
        .max_frame_size(Some(MAX_TEXT_FRAME_BYTES));
    let (socket, response) = complete_handshake(tungstenite::client_tls_with_config(
        request,
        stream,
        Some(config),
        None,
    ))?;
    if response.status() == 401 || response.status() == 403 {
        return Err(RealtimeError::Unauthorized);
    }
    Ok(TungsteniteSocket { socket })
}

fn complete_handshake<S: Read + Write>(
    result: Result<
        (
            tungstenite::WebSocket<S>,
            tungstenite::handshake::client::Response,
        ),
        HandshakeError<tungstenite::ClientHandshake<S>>,
    >,
) -> Result<
    (
        tungstenite::WebSocket<S>,
        tungstenite::handshake::client::Response,
    ),
    RealtimeError,
> {
    match result {
        Ok(ready) => Ok(ready),
        Err(HandshakeError::Failure(_)) => Err(RealtimeError::ConnectFailed),
        Err(HandshakeError::Interrupted(mut mid)) => loop {
            match mid.handshake() {
                Ok(ready) => return Ok(ready),
                Err(HandshakeError::Interrupted(next)) => mid = next,
                Err(HandshakeError::Failure(_)) => return Err(RealtimeError::ConnectFailed),
            }
        },
    }
}

fn send_text(socket: &mut TungsteniteSocket, payload: &str) -> Result<(), RealtimeError> {
    socket
        .socket
        .send(Message::Text(payload.into()))
        .map_err(|_| RealtimeError::ConnectFailed)?;
    socket
        .socket
        .flush()
        .map_err(|_| RealtimeError::ConnectFailed)
}

fn collect_turn(
    socket: &mut TungsteniteSocket,
    cancel: &AtomicBool,
) -> Result<RealtimeTurn, RealtimeError> {
    let mut assembler = InputTranscriptAssembler::new();
    let mut user_text = String::new();
    let mut assistant_text = String::new();
    let mut tts_pcm = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(RealtimeError::Cancelled);
        }
        let raw = socket.recv_text(SESSION_UPDATED_TIMEOUT)?;
        match parse_server_event(&raw)? {
            Some(ServerEvent::InputTranscriptDelta(payload)) => {
                if let Some((_, text, _)) = assembler.update("input_transcript_delta", &payload) {
                    user_text = text;
                }
            }
            Some(ServerEvent::InputTranscriptCompleted(payload)) => {
                if let Some((_, text, _)) = assembler.update("input_transcript_completed", &payload)
                {
                    user_text = text;
                }
            }
            Some(ServerEvent::OutputTranscript(delta) | ServerEvent::OutputText(delta)) => {
                assistant_text.push_str(&delta);
            }
            Some(ServerEvent::Audio(pcm)) => tts_pcm.extend_from_slice(&pcm),
            Some(ServerEvent::ResponseDone) => {
                let assistant_text = assistant_text.trim().to_owned();
                if assistant_text.is_empty() {
                    return Err(RealtimeError::TextEmpty);
                }
                return Ok(RealtimeTurn {
                    user_text: user_text.trim().to_owned(),
                    assistant_text,
                    tts_pcm,
                });
            }
            Some(ServerEvent::SessionCreated | ServerEvent::SessionUpdated) | None => {}
        }
    }
}

fn set_socket_timeouts(
    socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    timeout: Duration,
) -> Result<(), RealtimeError> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => set_tcp_timeouts(stream, timeout),
        MaybeTlsStream::Rustls(stream) => set_tcp_timeouts(stream.get_mut(), timeout),
        _ => Ok(()),
    }
}

fn set_tcp_timeouts(stream: &TcpStream, timeout: Duration) -> Result<(), RealtimeError> {
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|_| RealtimeError::ConnectFailed)?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|_| RealtimeError::ConnectFailed)
}
