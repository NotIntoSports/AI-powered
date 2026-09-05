use serde::Deserialize;
#[cfg(test)]
use std::path::Path;

#[cfg(test)]
use crate::config::{
    ApplicationConfig, DiagnosticsConfig, EmbeddingConfig, EmbeddingDistance, KnowledgeConfig,
    LiveKitConfig, ModelConfig, ProviderConfig, PublicConfig, RoleProfileConfig, SecretSlot,
    SpeechConfig, StorageConfig, TransportConfig, VoiceRouteConfig, VoiceRouteMode,
};
use crate::services::LiveKitJoinToken;
#[cfg(test)]
use crate::services::{
    DiscoveredModelDto, EmbeddingConfigSaveInput, EmbeddingTestResult, LiveKitSettingsSaveInput,
    LiveKitTestResult, MaterialSearchHit, MaterialSummary, ModelDiscoveryResult, ProviderSaveInput,
    ProviderTestResult, RoleProfileCopyInput, RoleProfileSaveInput, VoiceRouteSaveInput,
    VoiceRouteTestResult,
};

use serde::{Serialize, Serializer, ser::SerializeMap};
use ts_rs::TS;

pub use crate::error::PublicError;
pub use crate::runtime::PreflightIssue;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FoundationStatus {
    pub ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SecretStatus {
    pub reference: String,
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct DiagnosticsExportResult {
    pub exported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(tag = "kind", rename_all = "camelCase")]
pub enum StartupState {
    Ready,
    Migrated,
    Recoverable { error: PublicError },
    Invalid { error: PublicError },
}

#[derive(Debug, Clone, PartialEq, Eq, TS)]
#[ts(type = "{ ok: true; data: T } | { ok: false; error: PublicError }")]
pub enum CommandResult<T: TS> {
    Ok { data: T },
    Err { error: PublicError },
}

impl<T: Serialize + TS> Serialize for CommandResult<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(2))?;
        match self {
            Self::Ok { data } => {
                map.serialize_entry("ok", &true)?;
                map.serialize_entry("data", data)?;
            }
            Self::Err { error } => {
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", error)?;
            }
        }
        map.end()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub status: String,
    pub role_profile_id: String,
    pub voice_route_id: String,
    pub transport_mode: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
}

impl From<crate::sessions::SessionRecord> for SessionSummary {
    fn from(record: crate::sessions::SessionRecord) -> Self {
        Self {
            id: record.id,
            status: record.status,
            role_profile_id: record.role_profile_id,
            voice_route_id: record.voice_route_id,
            transport_mode: record.transport_mode,
            started_at: record.started_at,
            finished_at: record.finished_at,
            updated_at: record.updated_at,
        }
    }
}

/// Tagged start outcome. `Blocked` carries every preflight issue, not just the first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(tag = "kind", rename_all = "camelCase")]
#[allow(clippy::large_enum_variant)]
pub enum SessionStartResult {
    Started {
        session: SessionSummary,
        livekit: Option<LiveKitJoinToken>,
    },
    Blocked {
        issues: Vec<PreflightIssue>,
    },
}

/// Live runtime snapshot. Frontend must drop events or snapshots whose `seq`
/// is less than or equal to the last applied seq.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub phase: String,
    pub mode: String,
    #[ts(type = "number")]
    pub seq: u64,
    pub unused_materials: bool,
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SessionExportResult {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SessionCitationView {
    pub material_id: String,
    pub chunk_id: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SessionTurnView {
    pub id: String,
    #[ts(type = "number")]
    pub turn_index: i64,
    pub user_text: String,
    pub assistant_text: String,
    pub materials_used: bool,
    pub citations: Vec<SessionCitationView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: SessionSummary,
    pub turns: Vec<SessionTurnView>,
}

/// Transcript event. Frontend must drop this payload when `seq` is stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SessionTranscriptEvent {
    #[ts(type = "number")]
    pub seq: u64,
    pub text: String,
}

/// Reply event. Frontend must drop this payload when `seq` is stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SessionReplyEvent {
    #[ts(type = "number")]
    pub seq: u64,
    pub text: String,
}

/// Peak-only level event. Never includes PCM. Frontend must drop stale `seq`.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AudioLevelEvent {
    pub peak: f64,
    #[ts(type = "number")]
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentCommandInput {
    pub id: String,
    pub action: String,
    pub text: Option<String>,
    pub answer: Option<String>,
    pub mode: Option<String>,
    #[ts(type = "number")]
    pub expected_revision: u64,
}

/// Agent command result. `error` is a code only. Never includes PCM or provider bodies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentCommandResult {
    pub command_id: String,
    pub action: String,
    pub ok: bool,
    #[ts(type = "Record<string, unknown>")]
    pub result: serde_json::Value,
    pub error: String,
}

#[cfg(test)]
fn generated_bindings() -> String {
    let config = ts_rs::Config::default();
    // Registry of public DTO declarations. Emit order == registry order; adding a
    // new DTO to the public contract only requires adding one more `decl` entry.
    let decls = [
        PublicError::decl(&config),
        FoundationStatus::decl(&config),
        SecretStatus::decl(&config),
        DiagnosticsExportResult::decl(&config),
        StartupState::decl(&config),
        // Config contract DTOs (Phase 3 Stage B): the redacted public
        // configuration tree. Providers only carry SecretSlot references; no
        // secret value is ever part of this contract.
        SecretSlot::decl(&config),
        ApplicationConfig::decl(&config),
        ProviderConfig::decl(&config),
        ModelConfig::decl(&config),
        VoiceRouteMode::decl(&config),
        VoiceRouteConfig::decl(&config),
        SpeechConfig::decl(&config),
        LiveKitConfig::decl(&config),
        TransportConfig::decl(&config),
        EmbeddingDistance::decl(&config),
        EmbeddingConfig::decl(&config),
        KnowledgeConfig::decl(&config),
        StorageConfig::decl(&config),
        RoleProfileConfig::decl(&config),
        DiagnosticsConfig::decl(&config),
        PublicConfig::decl(&config),
        ProviderSaveInput::decl(&config),
        ProviderTestResult::decl(&config),
        DiscoveredModelDto::decl(&config),
        ModelDiscoveryResult::decl(&config),
        VoiceRouteSaveInput::decl(&config),
        VoiceRouteTestResult::decl(&config),
        RoleProfileSaveInput::decl(&config),
        RoleProfileCopyInput::decl(&config),
        EmbeddingConfigSaveInput::decl(&config),
        EmbeddingTestResult::decl(&config),
        LiveKitSettingsSaveInput::decl(&config),
        LiveKitTestResult::decl(&config),
        LiveKitJoinToken::decl(&config),
        MaterialSummary::decl(&config),
        MaterialSearchHit::decl(&config),
        PreflightIssue::decl(&config),
        SessionSummary::decl(&config),
        SessionStartResult::decl(&config),
        RuntimeStatus::decl(&config),
        SessionExportResult::decl(&config),
        SessionCitationView::decl(&config),
        SessionTurnView::decl(&config),
        SessionDetail::decl(&config),
        SessionTranscriptEvent::decl(&config),
        SessionReplyEvent::decl(&config),
        AudioLevelEvent::decl(&config),
        AgentCommandInput::decl(&config),
        AgentCommandResult::decl(&config),
        CommandResult::<FoundationStatus>::decl(&config),
    ];
    let header = "// Generated by ts-rs. Do not edit.\n";
    let body = decls
        .iter()
        .map(|decl| format!("export {decl}\n"))
        .collect::<Vec<String>>()
        .join("\n");
    format!("{header}\n{body}")
}

#[cfg(test)]
fn write_bindings(path: &Path) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create generated binding directory");
    }
    std::fs::write(path, generated_bindings()).expect("write generated TypeScript bindings");
}

#[cfg(test)]
mod tests {
    use super::{CommandResult, FoundationStatus, PublicError, generated_bindings, write_bindings};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn contracts_serialize_with_stable_shapes() {
        assert_eq!(
            serde_json::to_value(CommandResult::Ok {
                data: FoundationStatus { ready: true },
            })
            .unwrap(),
            json!({"ok": true, "data": {"ready": true}})
        );
        assert_eq!(
            serde_json::to_value(CommandResult::<FoundationStatus>::Err {
                error: PublicError::new("CONFIG_INVALID", "配置无效", false)
                    .with_field("providers"),
            })
            .unwrap()["ok"],
            false
        );
        assert_eq!(
            PublicError::new("CONFIG_INVALID", "配置无效", false).code,
            "CONFIG_INVALID"
        );
    }

    #[test]
    fn export_bindings() {
        let bindings = generated_bindings();
        assert!(
            bindings.contains("export type CommandResult<T>"),
            "unexpected bindings:\n{bindings}"
        );
        assert!(bindings.contains("ok: true"));
        assert!(bindings.contains("ok: false"));
        assert!(bindings.contains("export type SecretStatus"));
        assert!(bindings.contains("export type DiagnosticsExportResult"));
        assert!(bindings.contains("export type StartupState"));
        assert!(bindings.contains("export type PublicConfig"));
        assert!(bindings.contains("export type VoiceRouteMode"));
        assert!(bindings.contains("export type VoiceRouteConfig"));
        assert!(bindings.contains("export type RoleProfileConfig"));
        assert!(bindings.contains("export type EmbeddingConfig"));
        assert!(bindings.contains("export type LiveKitConfig"));
        assert!(bindings.contains("export type RoleProfileSaveInput"));
        assert!(bindings.contains("export type EmbeddingConfigSaveInput"));
        assert!(bindings.contains("export type LiveKitSettingsSaveInput"));
        assert!(bindings.contains("export type LiveKitJoinToken"));
        assert!(
            bindings.contains("export type MaterialSummary"),
            "unexpected bindings:\n{bindings}"
        );
        assert!(
            bindings.contains("export type MaterialSearchHit"),
            "unexpected bindings:\n{bindings}"
        );
        assert!(
            !bindings.contains("extractedText") && !bindings.contains("extracted_text"),
            "public bindings must not expose extracted document text:\n{bindings}"
        );
        for name in [
            "SessionSummary",
            "SessionStartResult",
            "PreflightIssue",
            "RuntimeStatus",
            "SessionExportResult",
            "SessionDetail",
            "SessionTurnView",
            "SessionCitationView",
            "SessionTranscriptEvent",
            "SessionReplyEvent",
            "AudioLevelEvent",
            "AgentCommandInput",
            "AgentCommandResult",
            "LiveKitJoinToken",
        ] {
            assert!(
                bindings.contains(&format!("export type {name}")),
                "missing {name} in bindings:\n{bindings}"
            );
        }
        assert!(
            !bindings.contains("pcm") && !bindings.contains("PCM"),
            "public bindings must not expose PCM:\n{bindings}"
        );
        assert!(
            bindings.contains("unusedMaterials") && bindings.contains("lastErrorCode"),
            "RuntimeStatus must expose unusedMaterials and lastErrorCode:\n{bindings}"
        );
        write_bindings(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/bindings.ts"));
    }
}
