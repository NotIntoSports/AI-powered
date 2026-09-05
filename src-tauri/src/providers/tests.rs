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
