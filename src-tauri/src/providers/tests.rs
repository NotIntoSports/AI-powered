use super::{normalize_models_url, parse_model_catalog};

#[test]
fn normalizes_openai_compatible_models_url() {
    assert_eq!(
        normalize_models_url("https://example.test/v1")
            .unwrap()
            .as_str(),
        "https://example.test/v1/models"
    );
    assert_eq!(
        normalize_models_url("https://example.test/v1/")
            .unwrap()
            .as_str(),
        "https://example.test/v1/models"
    );
    assert!(normalize_models_url("ftp://example.test/v1").is_err());
}

#[test]
fn parses_deduplicated_sorted_model_ids() {
    let models =
        parse_model_catalog(br#"{"data":[{"id":"zeta"},{"id":"alpha"},{"id":"alpha"},{"id":""}]}"#)
            .unwrap();
    assert_eq!(
        models.into_iter().map(|model| model.id).collect::<Vec<_>>(),
        vec!["alpha", "zeta"]
    );
}

#[test]
fn malformed_catalog_has_stable_error_without_body() {
    let error = parse_model_catalog(br#"{"upstreamSecret":"must-not-escape"}"#).unwrap_err();
    assert_eq!(error.code(), "PROVIDER_RESPONSE_INVALID");
    assert!(!error.to_string().contains("must-not-escape"));
}

mod embedding {
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::mpsc::{self, Receiver},
        thread,
        time::Duration,
    };

    use super::super::{EmbeddingProbe, OpenAiCompatibleEmbeddingProbe, ProviderEndpoint};

    const TEST_INPUT: &str = "AI Virtual Assistant embedding connectivity test";

    struct CapturedRequest {
        request_line: String,
        headers: String,
        body: Vec<u8>,
    }

    fn serve_once(response: Vec<u8>) -> (String, Receiver<CapturedRequest>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            stream.write_all(&response).unwrap();
            let _ = sender.send(request);
        });
        (format!("http://{address}/v1"), receiver)
    }

    fn read_request(stream: &mut TcpStream) -> CapturedRequest {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut received = Vec::new();
        let mut buffer = [0_u8; 4096];
        let header_end = loop {
            let count = stream.read(&mut buffer).unwrap();
            assert!(count > 0, "request ended before headers completed");
            received.extend_from_slice(&buffer[..count]);
            if let Some(position) = received.windows(4).position(|part| part == b"\r\n\r\n") {
                break position + 4;
            }
        };
        let headers = String::from_utf8(received[..header_end].to_vec()).unwrap();
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        while received.len() - header_end < content_length {
            let count = stream.read(&mut buffer).unwrap();
            assert!(count > 0, "request ended before body completed");
            received.extend_from_slice(&buffer[..count]);
        }
        CapturedRequest {
            request_line: headers.lines().next().unwrap().to_owned(),
            headers,
            body: received[header_end..header_end + content_length].to_vec(),
        }
    }

    fn response(status: &str, body: &[u8], extra_headers: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\n{extra_headers}Connection: close\r\n\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect()
    }

    fn endpoint(base_url: String) -> ProviderEndpoint {
        ProviderEndpoint {
            provider_id: "provider-1".into(),
            base_url,
        }
    }

    #[test]
    fn posts_exact_embedding_request_with_optional_bearer_auth_and_returns_floats() {
        let body = br#"{"data":[{"embedding":[0.25,-1.5,3.0]}]}"#;
        let (base_url, captured) = serve_once(response("200 OK", body, ""));
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();

        let vector = probe
            .embed(
                &endpoint(base_url),
                Some("synthetic-credential-marker"),
                "embed-model",
                3,
                TEST_INPUT,
            )
            .unwrap();

        assert_eq!(vector, vec![0.25, -1.5, 3.0]);
        let captured = captured.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(captured.request_line, "POST /v1/embeddings HTTP/1.1");
        assert!(
            captured
                .headers
                .to_ascii_lowercase()
                .contains("authorization: bearer synthetic-credential-marker\r\n")
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&captured.body).unwrap(),
            serde_json::json!({
                "input": "AI Virtual Assistant embedding connectivity test",
                "model": "embed-model",
                "dimensions": 3,
                "encoding_format": "float",
            })
        );
    }

    #[test]
    fn omits_authorization_for_configured_unauthenticated_endpoint() {
        let body = br#"{"data":[{"embedding":[1.0]}]}"#;
        let (base_url, captured) = serve_once(response("200 OK", body, ""));
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();

        assert_eq!(
            probe
                .embed(&endpoint(base_url), None, "local-model", 1, TEST_INPUT)
                .unwrap(),
            vec![1.0]
        );
        let captured = captured.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            !captured
                .headers
                .to_ascii_lowercase()
                .contains("authorization:")
        );
    }

    #[test]
    fn rejects_unauthorized_embedding_response_with_stable_code() {
        let marker = br#"{"message":"synthetic-upstream-marker"}"#;
        let (base_url, _) = serve_once(response("401 Unauthorized", marker, ""));
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();

        let error = probe
            .embed(&endpoint(base_url), None, "embed-model", 3, TEST_INPUT)
            .unwrap_err();

        assert_eq!(error.code(), "EMBEDDING_UNAUTHORIZED");
        assert!(!error.to_string().contains("synthetic-upstream-marker"));
    }

    #[test]
    fn times_out_a_slow_embedding_response_with_stable_code() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            thread::sleep(Duration::from_secs(11));
        });
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();

        let error = probe
            .embed(
                &endpoint(format!("http://{address}/v1")),
                None,
                "embed-model",
                3,
                TEST_INPUT,
            )
            .unwrap_err();

        assert_eq!(error.code(), "EMBEDDING_TIMEOUT");
    }

    #[test]
    fn rejects_redirect_without_following_it() {
        let (base_url, _) = serve_once(response(
            "302 Found",
            b"",
            "Location: http://127.0.0.1:9/capture\r\n",
        ));
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();

        let error = probe
            .embed(&endpoint(base_url), None, "embed-model", 3, TEST_INPUT)
            .unwrap_err();

        assert_eq!(error.code(), "EMBEDDING_REQUEST_FAILED");
    }

    #[test]
    fn rejects_embedding_response_over_one_mebibyte() {
        let body = vec![b'x'; 1024 * 1024 + 1];
        let (base_url, _) = serve_once(response("200 OK", &body, ""));
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();

        let error = probe
            .embed(&endpoint(base_url), None, "embed-model", 3, TEST_INPUT)
            .unwrap_err();

        assert_eq!(error.code(), "EMBEDDING_RESPONSE_TOO_LARGE");
    }

    #[test]
    fn rejects_malformed_embedding_json_without_exposing_response() {
        let marker = br#"{"syntheticResponseMarker":"must-not-escape"}"#;
        let (base_url, _) = serve_once(response("200 OK", marker, ""));
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();

        let error = probe
            .embed(&endpoint(base_url), None, "embed-model", 3, TEST_INPUT)
            .unwrap_err();

        assert_eq!(error.code(), "EMBEDDING_RESPONSE_INVALID");
        assert!(!error.to_string().contains("must-not-escape"));
    }

    #[test]
    fn rejects_values_that_overflow_f32() {
        let body = br#"{"data":[{"embedding":[3.5e38]}]}"#;
        let (base_url, _) = serve_once(response("200 OK", body, ""));
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();

        let error = probe
            .embed(&endpoint(base_url), None, "embed-model", 1, TEST_INPUT)
            .unwrap_err();

        assert_eq!(error.code(), "EMBEDDING_NON_FINITE_VALUE");
    }

    #[test]
    fn rejects_embedding_vector_with_wrong_dimension() {
        let body = br#"{"data":[{"embedding":[1.0,2.0]}]}"#;
        let (base_url, _) = serve_once(response("200 OK", body, ""));
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();

        let error = probe
            .embed(&endpoint(base_url), None, "embed-model", 3, TEST_INPUT)
            .unwrap_err();

        assert_eq!(error.code(), "EMBEDDING_DIMENSION_MISMATCH");
    }

    #[test]
    fn rejects_embedding_endpoints_with_userinfo_query_or_fragment() {
        let probe = OpenAiCompatibleEmbeddingProbe::new().unwrap();
        for base_url in [
            "https://user@example.test/v1",
            "https://example.test/v1?marker=synthetic",
            "https://example.test/v1#synthetic",
        ] {
            assert_eq!(
                probe
                    .embed(
                        &endpoint(base_url.into()),
                        None,
                        "embed-model",
                        3,
                        TEST_INPUT,
                    )
                    .unwrap_err()
                    .code(),
                "EMBEDDING_ENDPOINT_INVALID"
            );
        }
    }
}

mod livekit {
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::mpsc::{self, Receiver},
        thread,
        time::Duration,
    };

    use super::super::{LiveKitProbe, OfficialLiveKitProbe, control_url, room_list_token};

    struct CapturedRequest {
        request_line: String,
        headers: String,
        body: Vec<u8>,
    }

    fn serve_once(response: Vec<u8>) -> (String, Receiver<CapturedRequest>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            stream.write_all(&response).unwrap();
            let _ = sender.send(request);
        });
        (format!("ws://{address}"), receiver)
    }

    fn read_request(stream: &mut TcpStream) -> CapturedRequest {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut received = Vec::new();
        let mut buffer = [0_u8; 4096];
        let header_end = loop {
            let count = stream.read(&mut buffer).unwrap();
            assert!(count > 0, "request ended before headers completed");
            received.extend_from_slice(&buffer[..count]);
            if let Some(position) = received.windows(4).position(|part| part == b"\r\n\r\n") {
                break position + 4;
            }
        };
        let headers = String::from_utf8(received[..header_end].to_vec()).unwrap();
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        while received.len() - header_end < content_length {
            let count = stream.read(&mut buffer).unwrap();
            assert!(count > 0, "request ended before body completed");
            received.extend_from_slice(&buffer[..count]);
        }
        CapturedRequest {
            request_line: headers.lines().next().unwrap().to_owned(),
            headers,
            body: received[header_end..header_end + content_length].to_vec(),
        }
    }

    fn response(status: &str, body: &[u8], extra_headers: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\n{extra_headers}Connection: close\r\n\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect()
    }

    fn decode_jwt_payload(token: &str) -> serde_json::Value {
        use base64::Engine;
        let payload = token.split('.').nth(1).expect("jwt payload");
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn access_token_has_short_expiry_and_room_list_grant() {
        let token = room_list_token("devkey", "secret-marker").unwrap();
        let payload = decode_jwt_payload(token.as_str());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let exp = payload["exp"].as_i64().unwrap();
        assert!((55..=65).contains(&(exp - now)), "exp delta {}", exp - now);
        assert_eq!(payload["video"]["roomList"], true);
        assert_ne!(payload["video"]["roomJoin"], true);
        assert_ne!(payload["video"]["roomCreate"], true);
        assert!(!token.contains("secret-marker"));
    }

    #[test]
    fn posts_authenticated_list_rooms_on_converted_http_url() {
        let (base_url, captured) = serve_once(response("200 OK", br#"{"rooms":[]}"#, ""));
        OfficialLiveKitProbe::new()
            .unwrap()
            .test(&base_url, "devkey", "secret-marker")
            .unwrap();
        let captured = captured.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            captured.request_line,
            "POST /twirp/livekit.RoomService/ListRooms HTTP/1.1"
        );
        assert!(
            captured
                .headers
                .to_ascii_lowercase()
                .contains("authorization: bearer ")
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&captured.body).unwrap(),
            serde_json::json!({})
        );
        assert!(!String::from_utf8_lossy(&captured.body).contains("secret-marker"));
        assert_eq!(
            control_url("wss://livekit.example.test").unwrap().as_str(),
            "https://livekit.example.test/twirp/livekit.RoomService/ListRooms"
        );
    }

    #[test]
    fn rejects_bad_url_missing_credentials_and_sanitizes_errors() {
        let probe = OfficialLiveKitProbe::new().unwrap();
        assert_eq!(
            probe
                .test("https://example.test", "devkey", "secret")
                .unwrap_err()
                .code(),
            "LIVEKIT_ENDPOINT_INVALID"
        );
        assert_eq!(
            probe
                .test("ws://user@127.0.0.1:9", "devkey", "secret")
                .unwrap_err()
                .code(),
            "LIVEKIT_ENDPOINT_INVALID"
        );
        assert_eq!(
            probe
                .test("ws://127.0.0.1:9?x=1", "devkey", "secret")
                .unwrap_err()
                .code(),
            "LIVEKIT_ENDPOINT_INVALID"
        );
        assert_eq!(
            probe
                .test("ws://127.0.0.1:9#frag", "devkey", "secret")
                .unwrap_err()
                .code(),
            "LIVEKIT_ENDPOINT_INVALID"
        );
        assert_eq!(
            probe
                .test("ws://127.0.0.1:9", "", "secret")
                .unwrap_err()
                .code(),
            "LIVEKIT_CREDENTIALS_MISSING"
        );
        let marker = br#"{"message":"synthetic-token-marker"}"#;
        let (base_url, _) = serve_once(response("401 Unauthorized", marker, ""));
        let error = probe
            .test(&base_url, "devkey", "secret-marker")
            .unwrap_err();
        assert_eq!(error.code(), "LIVEKIT_UNAUTHORIZED");
        assert!(!error.to_string().contains("secret-marker"));
        assert!(!error.to_string().contains("synthetic-token-marker"));
    }

    #[test]
    fn times_out_and_rejects_redirect_oversize_and_malformed_responses() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            thread::sleep(Duration::from_secs(11));
        });
        let probe = OfficialLiveKitProbe::new().unwrap();
        assert_eq!(
            probe
                .test(&format!("ws://{address}"), "devkey", "secret")
                .unwrap_err()
                .code(),
            "LIVEKIT_TIMEOUT"
        );

        let (base_url, _) = serve_once(response(
            "302 Found",
            b"",
            "Location: http://127.0.0.1:9/capture\r\n",
        ));
        assert_eq!(
            probe
                .test(&base_url, "devkey", "secret")
                .unwrap_err()
                .code(),
            "LIVEKIT_REQUEST_FAILED"
        );

        let (base_url, _) = serve_once(response("200 OK", &vec![b'x'; 1024 * 1024 + 1], ""));
        assert_eq!(
            probe
                .test(&base_url, "devkey", "secret")
                .unwrap_err()
                .code(),
            "LIVEKIT_RESPONSE_TOO_LARGE"
        );

        let (base_url, _) = serve_once(response("200 OK", br#"{"ok":true}"#, ""));
        assert_eq!(
            probe
                .test(&base_url, "devkey", "secret")
                .unwrap_err()
                .code(),
            "LIVEKIT_RESPONSE_INVALID"
        );
    }
}
