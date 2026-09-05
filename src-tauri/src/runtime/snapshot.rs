use sha2::{Digest, Sha256};

use crate::config::{PublicConfig, RoleProfileConfig, VoiceRouteConfig};

use super::{active_embedding, active_role_profile, active_voice_route};

/// Public, persistable session fingerprint. Distinct from
/// [`crate::sessions::store::RuntimeSnapshot`] (the SQLite DTO).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRuntimeSnapshot {
    pub app_version: String,
    pub config_revision: String,
    pub provider_ids: Vec<String>,
    pub model_ids: Vec<String>,
    pub voice_route_id: String,
    pub transport_mode: String,
    pub role_hash: String,
    pub knowledge_fingerprint: String,
}

pub fn build_snapshot(config: &PublicConfig) -> SessionRuntimeSnapshot {
    let route = active_voice_route(config);
    let embedding = active_embedding(config);
    let (provider_ids, model_ids) = collect_ids(
        route,
        embedding.map(|item| (item.provider_id.as_str(), item.model_id.as_str())),
    );

    SessionRuntimeSnapshot {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        config_revision: config.config_version.to_string(),
        provider_ids,
        model_ids,
        voice_route_id: route.map(|item| item.id.clone()).unwrap_or_default(),
        transport_mode: "direct".to_owned(),
        role_hash: active_role_profile(config)
            .map(role_hash)
            .unwrap_or_default(),
        knowledge_fingerprint: embedding
            .map(|item| format!("{}|{}|{}", item.provider_id, item.model_id, item.dimensions))
            .unwrap_or_default(),
    }
}

fn collect_ids(
    route: Option<&VoiceRouteConfig>,
    embedding: Option<(&str, &str)>,
) -> (Vec<String>, Vec<String>) {
    let mut provider_ids = Vec::new();
    let mut model_ids = Vec::new();
    if let Some(route) = route {
        push_unique(&mut provider_ids, route.asr_provider_id.as_deref());
        push_unique(&mut model_ids, route.asr_model_id.as_deref());
        push_unique(&mut provider_ids, route.llm_provider_id.as_deref());
        push_unique(&mut model_ids, route.llm_model_id.as_deref());
        push_unique(&mut provider_ids, route.tts_provider_id.as_deref());
        push_unique(&mut model_ids, route.tts_model_id.as_deref());
        push_unique(&mut provider_ids, route.e2e_provider_id.as_deref());
        push_unique(&mut model_ids, route.e2e_model_id.as_deref());
    }
    if let Some((provider_id, model_id)) = embedding {
        push_unique(&mut provider_ids, Some(provider_id));
        push_unique(&mut model_ids, Some(model_id));
    }
    (provider_ids, model_ids)
}

fn push_unique(target: &mut Vec<String>, value: Option<&str>) {
    let Some(value) = value.filter(|item| !item.is_empty()) else {
        return;
    };
    if !target.iter().any(|existing| existing == value) {
        target.push(value.to_owned());
    }
}

fn role_hash(profile: &RoleProfileConfig) -> String {
    let material = format!(
        "{}|{}|{}",
        profile.system_prompt, profile.opening_message, profile.style_instructions
    );
    format!("{:x}", Sha256::digest(material.as_bytes()))
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::{SessionRuntimeSnapshot, build_snapshot};
    use crate::runtime::test_support::{PROMPT_MARKERS, ready_public_config};

    #[test]
    fn snapshot_hashes_role_without_prompt_text_or_urls() {
        let config = ready_public_config();
        let snapshot = build_snapshot(&config);

        assert_eq!(snapshot.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(snapshot.config_revision, config.config_version.to_string());
        assert_eq!(snapshot.voice_route_id, "route-1");
        assert_eq!(snapshot.transport_mode, "direct");
        assert_eq!(
            snapshot.provider_ids,
            vec!["asr-1", "llm-1", "tts-1", "emb-1"]
        );
        assert_eq!(
            snapshot.model_ids,
            vec!["whisper", "gpt", "tts-model", "bge"]
        );
        assert_eq!(snapshot.knowledge_fingerprint, "emb-1|bge|1024");
        assert_eq!(
            snapshot.role_hash,
            sha256_hex(
                "UNIQUE_PROMPT_BODY_DO_NOT_SNAPSHOT|UNIQUE_OPENING_DO_NOT_SNAPSHOT|UNIQUE_STYLE_DO_NOT_SNAPSHOT"
            )
        );

        assert_no_secrets_or_prompts(&snapshot);
    }

    #[test]
    fn snapshot_includes_e2e_ids_and_keeps_direct_transport() {
        let config = crate::runtime::test_support::ready_e2e_public_config();
        let snapshot = build_snapshot(&config);
        assert_eq!(snapshot.transport_mode, "direct");
        assert_eq!(snapshot.voice_route_id, "route-1");
        assert_eq!(snapshot.provider_ids, vec!["e2e-1", "emb-1"]);
        assert_eq!(snapshot.model_ids, vec!["gpt-realtime", "bge"]);
        assert_no_secrets_or_prompts(&snapshot);
    }

    #[test]
    fn snapshot_knowledge_fingerprint_is_empty_without_active_embedding() {
        let mut config = ready_public_config();
        config.knowledge.active_embedding_config_id = None;
        for embedding in &mut config.knowledge.embedding_configs {
            embedding.active = false;
        }

        let snapshot = build_snapshot(&config);
        assert!(snapshot.knowledge_fingerprint.is_empty());
        assert_eq!(snapshot.provider_ids, vec!["asr-1", "llm-1", "tts-1"]);
        assert_eq!(snapshot.model_ids, vec!["whisper", "gpt", "tts-model"]);
        assert_no_secrets_or_prompts(&snapshot);
    }

    fn sha256_hex(input: &str) -> String {
        format!("{:x}", Sha256::digest(input.as_bytes()))
    }

    fn assert_no_secrets_or_prompts(snapshot: &SessionRuntimeSnapshot) {
        let serialized = format!("{snapshot:?}");
        for marker in PROMPT_MARKERS {
            assert!(
                !serialized.contains(marker),
                "snapshot leaked prompt marker {marker}"
            );
        }
        assert!(!serialized.contains("https://"));
        assert!(!serialized.contains("http://"));
        assert!(!serialized.contains("sk-"));
        assert!(!serialized.contains("api-key"));
        assert!(!snapshot.role_hash.contains('|'));
    }
}
