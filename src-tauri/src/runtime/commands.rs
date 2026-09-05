use serde_json::{Map, Value, json};

use super::AgentMode;

const SAY_TEXT_LIMIT: usize = 500;
const CORRECT_ANSWER_LIMIT: usize = 4000;
const COMMAND_ID_LIMIT: usize = 128;
const REPORT_SUMMARY_LIMIT: usize = 2000;
const REPORT_LIST_LIMIT: usize = 10;
const REPORT_EVIDENCE_LIMIT: usize = 12;
const REPORT_TOPIC_LIMIT: usize = 100;
const REPORT_OBSERVATION_LIMIT: usize = 500;
const REPORT_QUOTE_LIMIT: usize = 300;
const REPORT_QUOTES_LIMIT: usize = 5;

const ALLOWED_FIELDS: &[&str] = &[
    "v",
    "id",
    "action",
    "text",
    "answer",
    "expectedRevision",
    "context",
    "mode",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCommandAction {
    Say,
    Retry,
    Correct,
    Report,
    SetMode,
}

impl AgentCommandAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Say => "say",
            Self::Retry => "retry",
            Self::Correct => "correct",
            Self::Report => "report",
            Self::SetMode => "set_mode",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "say" => Some(Self::Say),
            "retry" => Some(Self::Retry),
            "correct" => Some(Self::Correct),
            "report" => Some(Self::Report),
            "set_mode" => Some(Self::SetMode),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCommandError {
    Invalid,
    RevisionMismatch,
}

impl AgentCommandError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Invalid => "AGENT_COMMAND_INVALID",
            Self::RevisionMismatch => "SESSION_CHANGED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCommand {
    pub command_id: String,
    pub action: AgentCommandAction,
    pub text: String,
    pub answer: String,
    pub expected_revision: u64,
    pub mode: Option<AgentMode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCommandOutcome {
    pub command_id: String,
    pub action: AgentCommandAction,
    pub ok: bool,
    pub result: Map<String, Value>,
    pub error: String,
}

impl AgentCommandOutcome {
    pub fn ok(
        command_id: impl Into<String>,
        action: AgentCommandAction,
        result: Map<String, Value>,
    ) -> Self {
        Self {
            command_id: command_id.into(),
            action,
            ok: true,
            result,
            error: String::new(),
        }
    }

    pub fn fail(command_id: impl Into<String>, action: AgentCommandAction, error: &str) -> Self {
        Self {
            command_id: command_id.into(),
            action,
            ok: false,
            result: Map::new(),
            error: error.to_owned(),
        }
    }
}

pub fn command_requirements(action: AgentCommandAction) -> &'static [&'static str] {
    match action {
        AgentCommandAction::SetMode => &[],
        AgentCommandAction::Say => &["speak"],
        AgentCommandAction::Retry | AgentCommandAction::Correct => &["generate", "speak"],
        AgentCommandAction::Report => &["generate"],
    }
}

pub fn parse_agent_command(payload: &Value) -> Result<AgentCommand, AgentCommandError> {
    let object = payload.as_object().ok_or(AgentCommandError::Invalid)?;
    if object
        .keys()
        .any(|key| !ALLOWED_FIELDS.contains(&key.as_str()))
        || object.get("v").and_then(Value::as_u64) != Some(1)
    {
        return Err(AgentCommandError::Invalid);
    }
    let command_id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let action = object
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let action = AgentCommandAction::from_name(&action).ok_or(AgentCommandError::Invalid)?;
    if command_id.is_empty() || command_id.len() > COMMAND_ID_LIMIT {
        return Err(AgentCommandError::Invalid);
    }
    let text = object
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let answer = object
        .get("answer")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let expected_revision = match object.get("expectedRevision") {
        None => 0,
        Some(value) => value.as_u64().ok_or(AgentCommandError::Invalid)?,
    };
    if text.len() > SAY_TEXT_LIMIT || answer.len() > CORRECT_ANSWER_LIMIT {
        return Err(AgentCommandError::Invalid);
    }
    if (action == AgentCommandAction::Say && text.is_empty())
        || (action == AgentCommandAction::Correct && answer.is_empty())
    {
        return Err(AgentCommandError::Invalid);
    }
    let mode_raw = object
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let mode = if action == AgentCommandAction::SetMode {
        Some(AgentMode::from_name(&mode_raw).ok_or(AgentCommandError::Invalid)?)
    } else if mode_raw.is_empty() {
        None
    } else {
        return Err(AgentCommandError::Invalid);
    };
    if object
        .get("context")
        .is_some_and(|value| !value.is_object())
    {
        return Err(AgentCommandError::Invalid);
    }
    Ok(AgentCommand {
        command_id,
        action,
        text,
        answer,
        expected_revision,
        mode,
    })
}

pub fn assert_expected_revision(expected: u64, current: u64) -> Result<(), AgentCommandError> {
    if expected == current {
        Ok(())
    } else {
        Err(AgentCommandError::RevisionMismatch)
    }
}

pub fn execute_agent_command(
    command: &AgentCommand,
    mut generate: impl FnMut(&str) -> Result<String, AgentCommandError>,
    mut speak: impl FnMut(&str) -> Result<(), AgentCommandError>,
) -> Result<Map<String, Value>, AgentCommandError> {
    match command.action {
        AgentCommandAction::Say => {
            speak(&command.text)?;
            Ok(object([("text", json!(command.text))]))
        }
        AgentCommandAction::Retry => {
            let text = generate("根据对话历史重新生成上一条回复，只输出新的回复。")?;
            speak(&text)?;
            Ok(object([
                ("question", json!(text)),
                ("expectedRevision", json!(command.expected_revision)),
            ]))
        }
        AgentCommandAction::Correct => {
            speak(&command.answer)?;
            Ok(object([
                ("answer", json!(command.answer)),
                ("expectedRevision", json!(command.expected_revision)),
            ]))
        }
        AgentCommandAction::Report => {
            let report_text = generate(
                "根据完整对话生成纪要，只输出 JSON：summary 字符串，strengths、followUps、limitations 数组，evidence 数组。",
            )?;
            let parsed = serde_json::from_str::<Value>(&report_text).unwrap_or(json!({}));
            let report = normalize_report(&parsed, &report_text);
            let summary = report
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            Ok(object([
                ("summary", json!(summary)),
                ("report", Value::Object(report)),
            ]))
        }
        AgentCommandAction::SetMode => {
            let mode = command.mode.ok_or(AgentCommandError::Invalid)?;
            Ok(object([("mode", json!(mode.as_str()))]))
        }
    }
}

pub fn result_packet(
    command_id: &str,
    action: AgentCommandAction,
    result: Map<String, Value>,
    error: &str,
) -> AgentCommandOutcome {
    if error.is_empty() {
        AgentCommandOutcome::ok(command_id, action, result)
    } else {
        AgentCommandOutcome::fail(command_id, action, error)
    }
}

fn normalize_report(value: &Value, fallback: &str) -> Map<String, Value> {
    let payload = value.as_object();
    let summary = payload
        .and_then(|object| object.get("summary"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| clip(item, REPORT_SUMMARY_LIMIT))
        .unwrap_or_else(|| clip(fallback.trim(), REPORT_SUMMARY_LIMIT));
    let summary = if summary.is_empty() {
        "暂无可用纪要".to_owned()
    } else {
        summary
    };
    let mut evidence = Vec::new();
    if let Some(items) = payload
        .and_then(|object| object.get("evidence"))
        .and_then(Value::as_array)
    {
        for item in items.iter().take(REPORT_EVIDENCE_LIMIT) {
            let Some(entry) = item.as_object() else {
                continue;
            };
            let Some(topic) = entry
                .get("topic")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
            else {
                continue;
            };
            let Some(observation) = entry
                .get("observation")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
            else {
                continue;
            };
            evidence.push(json!({
                "topic": clip(topic, REPORT_TOPIC_LIMIT),
                "observation": clip(observation, REPORT_OBSERVATION_LIMIT),
                "quotes": string_list(entry.get("quotes"), REPORT_QUOTES_LIMIT, REPORT_QUOTE_LIMIT),
            }));
        }
    }
    object([
        ("summary", json!(summary)),
        (
            "strengths",
            json!(string_list(
                payload.and_then(|object| object.get("strengths")),
                REPORT_LIST_LIMIT,
                300
            )),
        ),
        (
            "followUps",
            json!(string_list(
                payload.and_then(|object| object.get("followUps")),
                REPORT_LIST_LIMIT,
                300
            )),
        ),
        (
            "limitations",
            json!(string_list(
                payload.and_then(|object| object.get("limitations")),
                REPORT_LIST_LIMIT,
                300
            )),
        ),
        ("evidence", json!(evidence)),
    ])
}

fn string_list(value: Option<&Value>, limit: usize, item_limit: usize) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(limit)
                .map(|item| clip(item, item_limit))
                .collect()
        })
        .unwrap_or_default()
}

fn object<const N: usize>(pairs: [(&str, Value); N]) -> Map<String, Value> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        AgentCommandAction, AgentCommandError, assert_expected_revision, command_requirements,
        execute_agent_command, parse_agent_command, result_packet,
    };
    use crate::runtime::AgentMode;
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn report_requires_generation_but_not_audio() {
        assert_eq!(
            command_requirements(AgentCommandAction::Report),
            ["generate"]
        );
        assert_eq!(
            command_requirements(AgentCommandAction::Retry),
            ["generate", "speak"]
        );
        assert_eq!(command_requirements(AgentCommandAction::Say), ["speak"]);
        assert!(command_requirements(AgentCommandAction::SetMode).is_empty());
    }

    #[test]
    fn parses_versioned_retry_command() {
        let command = parse_agent_command(&json!({
            "v": 1,
            "id": "cmd-1",
            "action": "retry",
            "expectedRevision": 4
        }))
        .expect("retry");
        assert_eq!(command.action, AgentCommandAction::Retry);
        assert_eq!(command.expected_revision, 4);
        assert_eq!(command.command_id, "cmd-1");
    }

    #[test]
    fn parses_hyphenated_agent_mode_without_generation() {
        let command = parse_agent_command(&json!({
            "v": 1,
            "id": "cmd-mode-1",
            "action": "set_mode",
            "mode": "ai-active",
        }))
        .expect("set_mode");
        assert_eq!(command.action, AgentCommandAction::SetMode);
        assert_eq!(command.mode, Some(AgentMode::AiActive));
        assert!(command_requirements(command.action).is_empty());
    }

    #[test]
    fn rejects_unknown_agent_mode() {
        let error = parse_agent_command(&json!({
            "v": 1,
            "id": "cmd-mode-2",
            "action": "set_mode",
            "mode": "guess-the-speaker",
        }))
        .expect_err("invalid mode");
        assert_eq!(error.code(), "AGENT_COMMAND_INVALID");
    }

    #[test]
    fn rejects_model_or_secret_fields() {
        let error = parse_agent_command(&json!({
            "v": 1,
            "id": "cmd-1",
            "action": "say",
            "text": "hi",
            "modelId": "x"
        }))
        .expect_err("secret field");
        assert_eq!(error.code(), "AGENT_COMMAND_INVALID");
    }

    #[test]
    fn result_packet_carries_command_correlation_and_error_code() {
        let packet = result_packet(
            "cmd-1",
            AgentCommandAction::Retry,
            [("question", json!("下一题"))]
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
            "",
        );
        assert_eq!(packet.command_id, "cmd-1");
        assert_eq!(packet.action, AgentCommandAction::Retry);
        assert!(packet.ok);
        assert_eq!(packet.result["question"], "下一题");
        assert_eq!(packet.error, "");
        let failed = result_packet(
            "cmd-1",
            AgentCommandAction::Retry,
            Default::default(),
            "SESSION_CHANGED",
        );
        assert!(!failed.ok);
        assert_eq!(failed.error, "SESSION_CHANGED");
        assert!(failed.result.is_empty());
    }

    #[test]
    fn say_speaks_given_text() {
        let spoken = Mutex::new(Vec::new());
        let command = parse_agent_command(&json!({
            "v": 1,
            "id": "cmd-say",
            "action": "say",
            "text": "请开始自我介绍"
        }))
        .unwrap();
        let result = execute_agent_command(
            &command,
            |_| panic!("say must not generate"),
            |text| {
                spoken.lock().unwrap().push(text.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result["text"], "请开始自我介绍");
        assert_eq!(*spoken.lock().unwrap(), ["请开始自我介绍"]);
    }

    #[test]
    fn retry_generates_and_speaks_question() {
        let spoken = Mutex::new(Vec::new());
        let command = parse_agent_command(&json!({
            "v": 1,
            "id": "cmd-1",
            "action": "retry",
            "expectedRevision": 4
        }))
        .unwrap();
        let result = execute_agent_command(
            &command,
            |_| Ok("下一题".into()),
            |text| {
                spoken.lock().unwrap().push(text.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result["question"], "下一题");
        assert_eq!(result["expectedRevision"], 4);
        assert_eq!(*spoken.lock().unwrap(), ["下一题"]);
    }

    #[test]
    fn correct_speaks_replacement_text_without_generating() {
        let spoken = Mutex::new(Vec::new());
        let command = parse_agent_command(&json!({
            "v": 1,
            "id": "cmd-correct",
            "action": "correct",
            "answer": "修正后的回答",
            "expectedRevision": 2
        }))
        .unwrap();
        let result = execute_agent_command(
            &command,
            |_| panic!("correct replaces last assistant and must not generate"),
            |text| {
                spoken.lock().unwrap().push(text.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result["answer"], "修正后的回答");
        assert_eq!(result["expectedRevision"], 2);
        assert_eq!(*spoken.lock().unwrap(), ["修正后的回答"]);
    }

    #[test]
    fn report_generates_without_speaking() {
        let spoken = Mutex::new(Vec::new());
        let command = parse_agent_command(&json!({
            "v": 1,
            "id": "cmd-2",
            "action": "report"
        }))
        .unwrap();
        let result = execute_agent_command(
            &command,
            |_| {
                Ok(
                    r#"{"summary":"摘要","strengths":[],"followUps":[],"limitations":[],"evidence":[]}"#
                        .into(),
                )
            },
            |text| {
                spoken.lock().unwrap().push(text.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result["summary"], "摘要");
        assert_eq!(result["report"]["summary"], "摘要");
        assert!(spoken.lock().unwrap().is_empty());
        assert!(result.get("pcm").is_none());
    }

    #[test]
    fn report_normalizes_incomplete_model_json() {
        let command = parse_agent_command(&json!({
            "v": 1,
            "id": "cmd-3",
            "action": "report"
        }))
        .unwrap();
        let result = execute_agent_command(
            &command,
            |_| {
                Ok(
                    r#"{"summary":"摘要","strengths":"错误类型","evidence":[{"topic":"主题"}]}"#
                        .into(),
                )
            },
            |_| panic!("report must not speak"),
        )
        .unwrap();
        let report = &result["report"];
        assert_eq!(report["strengths"], json!([]));
        assert_eq!(report["evidence"], json!([]));
        assert_eq!(report["followUps"], json!([]));
        assert_eq!(result["summary"], "摘要");
    }

    #[test]
    fn revision_mismatch_fails_closed() {
        let error = assert_expected_revision(4, 5).expect_err("mismatch");
        assert_eq!(error, AgentCommandError::RevisionMismatch);
        assert_eq!(error.code(), "SESSION_CHANGED");
        assert!(assert_expected_revision(4, 4).is_ok());
    }
}
