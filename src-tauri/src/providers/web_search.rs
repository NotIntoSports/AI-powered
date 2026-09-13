use super::cascade::{CascadeError, CascadeStage, ChatMessage};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum WebCapability {
    #[default]
    None,
    OpenaiResponsesWebSearch,
    QwenResponsesWebSearch,
    QwenChatEnableSearch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum WebCapabilityStatus {
    Disabled,
    Available,
    ModelUnsupported,
    InterfaceIncompatible,
    NetworkUnreachable,
    AuthenticationFailed,
}

pub fn probe_status_from_result(
    result: Result<&WebCompletion, super::cascade::CascadeError>,
) -> WebCapabilityStatus {
    use super::cascade::{CascadeError, CascadeStage};
    match result {
        Ok(completion) if !completion.sources.is_empty() => WebCapabilityStatus::Available,
        Ok(completion) if completion.degraded => WebCapabilityStatus::InterfaceIncompatible,
        Ok(_) => WebCapabilityStatus::ModelUnsupported,
        Err(CascadeError::Unauthorized(CascadeStage::Llm)) => {
            WebCapabilityStatus::AuthenticationFailed
        }
        Err(
            CascadeError::EndpointInvalid(CascadeStage::Llm)
            | CascadeError::ResponseInvalid(CascadeStage::Llm)
            | CascadeError::ResponseEmpty(CascadeStage::Llm),
        ) => WebCapabilityStatus::InterfaceIncompatible,
        Err(_) => WebCapabilityStatus::NetworkUnreachable,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct WebSource {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Default)]
pub struct WebCompletion {
    pub text: String,
    pub sources: Vec<WebSource>,
    pub degraded: bool,
}

pub fn search_request(capability: WebCapability, model: &str, messages: &[ChatMessage]) -> Value {
    match capability {
        WebCapability::OpenaiResponsesWebSearch | WebCapability::QwenResponsesWebSearch => {
            let mut value = json!({ "model": model, "input": messages, "tools": [{ "type": "web_search" }], "store": false });
            if capability == WebCapability::OpenaiResponsesWebSearch {
                value["include"] = json!(["web_search_call.action.sources"]);
            }
            value
        }
        WebCapability::QwenChatEnableSearch => {
            json!({ "model": model, "messages": messages, "enable_search": true, "search_options": { "enable_source": true } })
        }
        WebCapability::None => json!({ "model": model, "messages": messages }),
    }
}

pub fn parse_search_response(
    capability: WebCapability,
    bytes: &[u8],
) -> Result<WebCompletion, CascadeError> {
    let body: Value = serde_json::from_slice(bytes)
        .map_err(|_| CascadeError::ResponseInvalid(CascadeStage::Llm))?;
    let mut completion = WebCompletion::default();
    match capability {
        WebCapability::OpenaiResponsesWebSearch | WebCapability::QwenResponsesWebSearch => {
            if body
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|s| s != "completed")
                || body.get("error").is_some_and(|e| !e.is_null())
            {
                return Err(CascadeError::ResponseInvalid(CascadeStage::Llm));
            }
            for item in body["output"].as_array().into_iter().flatten() {
                if item["type"] == "message" {
                    for content in item["content"].as_array().into_iter().flatten() {
                        if content["type"] != "output_text" {
                            continue;
                        }
                        completion
                            .text
                            .push_str(content["text"].as_str().unwrap_or_default());
                        for annotation in content["annotations"].as_array().into_iter().flatten() {
                            if annotation["type"] == "url_citation" {
                                add_source(&mut completion.sources, annotation);
                            }
                        }
                    }
                } else if item["type"] == "web_search_call" {
                    for source in item["action"]["sources"].as_array().into_iter().flatten() {
                        add_source(&mut completion.sources, source);
                    }
                }
            }
        }
        _ => {
            completion.text = body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or_default()
                .into();
            for source in body["search_info"]["search_results"]
                .as_array()
                .into_iter()
                .flatten()
            {
                add_source(&mut completion.sources, source);
            }
        }
    }
    if completion.text.trim().is_empty() {
        return Err(CascadeError::ResponseEmpty(CascadeStage::Llm));
    }
    Ok(completion)
}

fn add_source(sources: &mut Vec<WebSource>, value: &Value) {
    if sources.len() >= 20 {
        return;
    }
    let Some(raw) = value["url"].as_str() else {
        return;
    };
    let Ok(url) = reqwest::Url::parse(raw) else {
        return;
    };
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return;
    }
    if sources.iter().any(|s| s.url == url.as_str()) {
        return;
    }
    sources.push(WebSource {
        title: value["title"]
            .as_str()
            .unwrap_or(url.host_str().unwrap_or("来源"))
            .chars()
            .take(200)
            .collect(),
        url: url.into(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_requests_never_include_search_tools() {
        let body = search_request(WebCapability::None, "model", &[]);
        assert!(body.get("tools").is_none());
        assert!(body.get("enable_search").is_none());
        assert_eq!(
            search_request(WebCapability::QwenChatEnableSearch, "qwen", &[])["enable_search"],
            true
        );
        assert_eq!(
            search_request(WebCapability::OpenaiResponsesWebSearch, "model", &[])["tools"][0]["type"],
            "web_search"
        );
    }

    #[test]
    fn capability_probe_requires_real_sources_and_maps_failures() {
        let available = WebCompletion {
            text: "answer".into(),
            sources: vec![WebSource {
                title: "source".into(),
                url: "https://example.com/".into(),
            }],
            degraded: false,
        };
        assert_eq!(
            probe_status_from_result(Ok(&available)),
            WebCapabilityStatus::Available
        );
        let degraded = WebCompletion {
            text: "fallback".into(),
            sources: vec![],
            degraded: true,
        };
        assert_eq!(
            probe_status_from_result(Ok(&degraded)),
            WebCapabilityStatus::InterfaceIncompatible
        );
        assert_eq!(
            probe_status_from_result(Err(CascadeError::Unauthorized(CascadeStage::Llm))),
            WebCapabilityStatus::AuthenticationFailed
        );
    }
    #[test]
    fn parses_actual_sources_and_rejects_unsafe_links() {
        let body = json!({ "status": "completed", "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "answer", "annotations": [{ "type": "url_citation", "url": "https://example.com/a", "title": "source" }, { "type": "url_citation", "url": "javascript:alert(1)" }] }] }] });
        let response = parse_search_response(
            WebCapability::OpenaiResponsesWebSearch,
            &serde_json::to_vec(&body).unwrap(),
        )
        .unwrap();
        assert_eq!(response.text, "answer");
        assert_eq!(response.sources.len(), 1);
        let plain = parse_search_response(
            WebCapability::QwenChatEnableSearch,
            br#"{"choices":[{"message":{"content":"answer"}}]}"#,
        )
        .unwrap();
        assert!(plain.sources.is_empty());
    }
}
