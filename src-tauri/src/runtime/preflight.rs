use serde::Serialize;
use ts_rs::TS;

use crate::config::{PublicConfig, VoiceRouteConfig, VoiceRouteMode};

use super::{active_role_profile, active_voice_route};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PreflightIssue {
    pub code: &'static str,
    pub area: &'static str,
    pub action: &'static str,
}

const fn issue(code: &'static str, area: &'static str, action: &'static str) -> PreflightIssue {
    PreflightIssue { code, area, action }
}

pub fn preflight(config: &PublicConfig, secrets_ready: bool, db_ok: bool) -> Vec<PreflightIssue> {
    let mut issues = Vec::new();
    let route = active_voice_route(config);

    match route {
        None => issues.push(issue("SESSION_ROUTE_REQUIRED", "speech", "open_services")),
        Some(route) if route.mode == VoiceRouteMode::E2e => {
            issues.push(issue("SESSION_ROUTE_NOT_DIRECT", "speech", "open_services"))
        }
        Some(route) if cascade_incomplete(route) => {
            issues.push(issue("SESSION_STAGE_INCOMPLETE", "speech", "open_services"))
        }
        Some(_) => {}
    }

    if credential_missing(config, route, secrets_ready) {
        issues.push(issue(
            "SESSION_CREDENTIAL_MISSING",
            "speech",
            "open_services",
        ));
    }

    if active_role_profile(config).is_none() {
        issues.push(issue("SESSION_ROLE_REQUIRED", "role", "open_services"));
    }

    if !db_ok {
        issues.push(issue("SESSION_DATABASE_UNAVAILABLE", "database", "retry"));
    }

    issues
}

fn cascade_incomplete(route: &VoiceRouteConfig) -> bool {
    route.mode == VoiceRouteMode::Cascaded
        && [
            route.asr_provider_id.as_deref(),
            route.asr_model_id.as_deref(),
            route.llm_provider_id.as_deref(),
            route.llm_model_id.as_deref(),
            route.tts_provider_id.as_deref(),
            route.tts_model_id.as_deref(),
        ]
        .iter()
        .any(|value| value.is_none_or(|item| item.is_empty()))
}

fn credential_missing(
    config: &PublicConfig,
    route: Option<&VoiceRouteConfig>,
    secrets_ready: bool,
) -> bool {
    let referenced = referenced_provider_ids(route);
    if referenced.is_empty() {
        return false;
    }
    if !secrets_ready {
        return true;
    }
    referenced.iter().any(|provider_id| {
        config
            .models
            .providers
            .iter()
            .find(|provider| provider.id == *provider_id)
            .and_then(|provider| provider.credential.as_ref())
            .is_some_and(|slot| !slot.configured)
    })
}

fn referenced_provider_ids(route: Option<&VoiceRouteConfig>) -> Vec<&str> {
    let Some(route) = route else {
        return Vec::new();
    };
    let ids = match route.mode {
        VoiceRouteMode::Cascaded => [
            route.asr_provider_id.as_deref(),
            route.llm_provider_id.as_deref(),
            route.tts_provider_id.as_deref(),
        ],
        VoiceRouteMode::E2e => [route.e2e_provider_id.as_deref(), None, None],
    };
    ids.into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{PreflightIssue, preflight};
    use crate::config::{VoiceRouteMode, public_view};
    use crate::runtime::test_support::{empty_public_config, ready_public_config};

    #[test]
    fn preflight_returns_every_issue_not_just_the_first() {
        let issues = preflight(&empty_public_config(), false, false);
        assert!(
            issues.len() >= 2,
            "expected all issues at once, got {issues:?}"
        );
        assert_codes(
            &issues,
            &[
                "SESSION_ROUTE_REQUIRED",
                "SESSION_ROLE_REQUIRED",
                "SESSION_DATABASE_UNAVAILABLE",
            ],
        );
        assert_issue(&issues, "SESSION_ROUTE_REQUIRED", "speech", "open_services");
    }

    #[test]
    fn preflight_flags_e2e_route_incomplete_stages_and_missing_secrets() {
        let mut config = ready_public_config();
        config.speech.voice_routes[0].mode = VoiceRouteMode::E2e;
        config.speech.voice_routes[0].asr_provider_id = None;
        config.speech.voice_routes[0].asr_model_id = None;
        config.active_role_profile_id = None;
        config.role_profiles[0].active = false;

        let issues = preflight(&config, false, true);
        assert!(issues.len() >= 2, "got {issues:?}");
        assert_codes(
            &issues,
            &["SESSION_ROUTE_NOT_DIRECT", "SESSION_ROLE_REQUIRED"],
        );
    }

    #[test]
    fn preflight_reports_incomplete_cascade_and_unready_secrets() {
        let mut config = ready_public_config();
        config.speech.voice_routes[0].tts_model_id = None;
        if let Some(provider) = config
            .models
            .providers
            .iter_mut()
            .find(|provider| provider.id == "asr-1")
            && let Some(slot) = &mut provider.credential
        {
            slot.configured = false;
        }

        let issues = preflight(&config, false, true);
        assert!(issues.len() >= 2, "got {issues:?}");
        assert_codes(
            &issues,
            &["SESSION_STAGE_INCOMPLETE", "SESSION_CREDENTIAL_MISSING"],
        );
    }

    #[test]
    fn ready_direct_route_with_secrets_and_db_has_no_issues() {
        let issues = preflight(&ready_public_config(), true, true);
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn inactive_cascaded_route_is_treated_as_missing() {
        let mut config = ready_public_config();
        config.speech.voice_routes[0].active = false;
        config.speech.active_voice_route_id = None;
        let issues = preflight(&config, true, true);
        assert_codes(&issues, &["SESSION_ROUTE_REQUIRED"]);
        assert_issue(&issues, "SESSION_ROUTE_REQUIRED", "speech", "open_services");
    }

    #[test]
    fn public_view_round_trip_is_accepted() {
        let issues = preflight(
            &public_view(&crate::config::AppConfigV1::default()),
            true,
            true,
        );
        assert!(!issues.is_empty());
    }

    fn assert_codes(issues: &[PreflightIssue], expected: &[&str]) {
        for code in expected {
            assert!(
                issues.iter().any(|issue| issue.code == *code),
                "missing {code} in {issues:?}"
            );
        }
    }

    fn assert_issue(issues: &[PreflightIssue], code: &str, area: &str, action: &str) {
        let issue = issues
            .iter()
            .find(|issue| issue.code == code)
            .unwrap_or_else(|| panic!("missing {code}"));
        assert_eq!(issue.area, area);
        assert_eq!(issue.action, action);
    }
}
