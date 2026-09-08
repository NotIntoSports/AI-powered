use crate::config::is_stable_id;

pub(crate) fn resolve_optional_id(id: Option<&str>) -> Result<String, ()> {
    let trimmed = id.unwrap_or("").trim();
    if trimmed.is_empty() {
        return Ok(uuid::Uuid::new_v4().to_string());
    }
    if is_stable_id(trimmed) {
        Ok(trimmed.to_owned())
    } else {
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_optional_id;

    #[test]
    fn empty_or_missing_id_generates_uuid() {
        for id in [None, Some(""), Some("  ")] {
            let generated = resolve_optional_id(id).unwrap();
            assert!(uuid::Uuid::parse_str(&generated).is_ok());
        }
    }

    #[test]
    fn explicit_stable_id_is_kept() {
        assert_eq!(resolve_optional_id(Some("openai")).unwrap(), "openai");
        assert_eq!(
            resolve_optional_id(Some("  example-route_1  ")).unwrap(),
            "example-route_1"
        );
    }

    #[test]
    fn invalid_explicit_id_is_rejected() {
        for id in ["Uppercase", "has space", "bad.id"] {
            assert_eq!(resolve_optional_id(Some(id)), Err(()));
        }
    }
}
