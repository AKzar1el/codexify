use std::sync::OnceLock;

use super::CompanionSelection;

fn order() -> &'static [CompanionSelection] {
    static ORDER: OnceLock<Vec<CompanionSelection>> = OnceLock::new();
    ORDER.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../browser-companion/model-fallback-order.json"
        ))
        .expect("the checked-in model fallback order must be valid")
    })
}

pub(super) fn selection_allowed(
    model: Option<&str>,
    effort: Option<&str>,
    actual: &CompanionSelection,
) -> bool {
    if model == Some(actual.model.as_str()) && effort == Some(actual.effort.as_str()) {
        return true;
    }
    let preferred = order().iter().position(|item| {
        Some(item.model.as_str()) == model && Some(item.effort.as_str()) == effort
    });
    let selected = order().iter().position(|item| item == actual);
    matches!((preferred, selected), (Some(preferred), Some(selected)) if selected > preferred)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_order_matches_the_requested_priority_and_has_no_duplicates() {
        let selections = order();
        let prefix: Vec<_> = selections[..4]
            .iter()
            .map(|item| (item.model.as_str(), item.effort.as_str()))
            .collect();
        assert_eq!(
            prefix,
            vec![
                ("gpt-6-astra", "max"),
                ("gpt-5.6-sol", "max"),
                ("gpt-6-sol", "xhigh"),
                ("gpt-6-sol", "high")
            ]
        );
        let unique: std::collections::HashSet<_> = selections
            .iter()
            .map(|item| (&item.model, &item.effort))
            .collect();
        assert_eq!(unique.len(), selections.len());
    }

    #[test]
    fn only_exact_or_lower_ranked_selections_are_allowed() {
        let choice = |model: &str, effort: &str| CompanionSelection {
            model: model.into(),
            effort: effort.into(),
        };
        assert!(selection_allowed(
            Some("gpt-6-astra"),
            Some("max"),
            &choice("gpt-5.6-sol", "max")
        ));
        assert!(selection_allowed(
            Some("gpt-5.6-sol"),
            Some("max"),
            &choice("gpt-6-sol", "xhigh")
        ));
        assert!(selection_allowed(
            Some("gpt-6-sol"),
            Some("high"),
            &choice("gpt-6-sol", "medium")
        ));
        assert!(!selection_allowed(
            Some("gpt-6-sol"),
            Some("high"),
            &choice("gpt-6-astra", "max")
        ));
        assert!(!selection_allowed(
            Some("future-model"),
            Some("deep"),
            &choice("gpt-6-sol", "high")
        ));
        assert!(!selection_allowed(
            Some("gpt-6-astra"),
            Some("max"),
            &choice("future-model", "deep")
        ));
        assert!(selection_allowed(
            Some("future-model"),
            Some("deep"),
            &choice("future-model", "deep")
        ));
        assert!(!selection_allowed(None, None, &choice("gpt-6-sol", "high")));
    }
}
