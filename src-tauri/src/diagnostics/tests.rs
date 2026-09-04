use chrono::{Duration, Utc};

use super::{DiagnosticEvent, DiagnosticWriter, MAX_FILE_BYTES, redact_text};

fn event(timestamp: chrono::DateTime<Utc>, code: &str) -> DiagnosticEvent {
    DiagnosticEvent {
        timestamp,
        level: "error".into(),
        area: "provider".into(),
        code: code.into(),
        request_id: uuid::Uuid::new_v4().to_string(),
        session_id: None,
        snapshot_id: None,
        provider_id: Some("provider-1".into()),
        duration_ms: Some(12),
        retry_count: Some(0),
    }
}

#[test]
fn redacts_credentials_urls_queries_and_json_fields_and_bounds_messages() {
    let input = r#"Authorization: Bearer bearer-value apiKey=key-value access_token=token-value password=credential-pw secret=hidden https://url-user:url-pass@example.com/path?token=query-value&safe=yes {\"password\":\"json-pw\",\"safe\":\"ok\"}"#;
    let output = redact_text(input);
    for forbidden in [
        "bearer-value",
        "key-value",
        "token-value",
        "credential-pw",
        "hidden",
        "url-user",
        "url-pass",
        "query-value",
        "json-pw",
    ] {
        assert!(!output.contains(forbidden), "leaked {forbidden}: {output}");
    }
    assert!(output.chars().count() <= 2_000);
    assert_eq!(redact_text(&"a".repeat(3_000)).chars().count(), 2_000);
}

#[test]
fn events_have_only_the_public_field_allowlist() {
    let value = serde_json::to_value(event(Utc::now(), "TEST")).unwrap();
    let keys = value
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    for forbidden in [
        "message",
        "transcript",
        "audio",
        "document",
        "body",
        "headers",
    ] {
        assert!(!keys.iter().any(|key| key == forbidden));
    }
}

#[test]
fn writer_rotates_before_five_mib_and_removes_events_older_than_fourteen_days() {
    let directory = tempfile::tempdir().unwrap();
    let writer = DiagnosticWriter::new(directory.path().to_path_buf()).unwrap();
    writer
        .record(&event(Utc::now() - Duration::days(15), &"x".repeat(1_900)))
        .unwrap();
    writer.record(&event(Utc::now(), "CURRENT")).unwrap();
    writer.cleanup(Utc::now()).unwrap();
    let events = writer.events().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].code, "CURRENT");

    std::fs::write(writer.active_path(), vec![b'x'; MAX_FILE_BYTES - 10]).unwrap();
    writer.record(&event(Utc::now(), "ROTATE")).unwrap();
    assert!(writer.rotated_path().exists());
    assert!(std::fs::metadata(writer.active_path()).unwrap().len() <= MAX_FILE_BYTES as u64);
}

#[test]
fn export_is_bounded_and_contains_no_content_payload_fields() {
    let directory = tempfile::tempdir().unwrap();
    let writer = DiagnosticWriter::new(directory.path().join("logs")).unwrap();
    writer.record(&event(Utc::now(), "EXPORT")).unwrap();
    let destination = directory.path().join("report.json");
    writer
        .export(
            &destination,
            serde_json::json!({"configVersion": 1}),
            serde_json::json!({"database": "ready"}),
        )
        .unwrap();
    let report = std::fs::read_to_string(destination).unwrap();
    assert!(report.contains("EXPORT"));
    for forbidden in ["transcript", "audioData", "documentText", "secretValue"] {
        assert!(!report.contains(forbidden));
    }
    assert!(report.len() <= MAX_FILE_BYTES);
}
