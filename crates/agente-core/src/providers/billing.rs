//! Normalize reported charges before the catalog fallback prices a call.
use crate::llm::Usage;
use serde_json::Value;

fn amount(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
}

/// OpenCode's zero balance charge on a subscription is not zero usage.
/// Prefer its reported allowance consumption, then its list-price estimate.
/// The extension lives beside usage on all four supported wire protocols.
pub(super) fn record_cost(usage: &mut Usage, raw: &Value) {
    let meta = &raw["opencode"];
    if matches!(
        meta["billing_source"].as_str(),
        Some("go" | "go-plus" | "go-teams")
    ) {
        let allowance = amount(&meta["allowance"]);
        usage.cost_usd = allowance.or_else(|| amount(&meta["list_cost"]));
        usage.cost_estimated = allowance.is_none();
    } else if raw.get("cost").is_some() {
        usage.cost_usd = amount(&raw["cost"]);
        usage.cost_estimated = meta["estimated"].as_bool().unwrap_or(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn subscription_consumption_is_not_a_free_balance_charge() {
        for source in ["go", "go-plus", "go-teams"] {
            let mut usage = Usage::default();
            record_cost(
                &mut usage,
                &json!({"cost":0,"opencode":{"billing_source":source,"allowance":0.012,"list_cost":0.03}}),
            );
            assert_eq!(usage.cost_usd, Some(0.012));
            assert!(!usage.cost_estimated);
            // An unrelated usage delta must not erase reported accounting.
            record_cost(&mut usage, &json!({"output_tokens":100}));
            assert_eq!(usage.cost_usd, Some(0.012));
        }
    }

    #[test]
    fn missing_allowance_uses_an_estimate_or_remains_unpriced() {
        let mut usage = Usage::default();
        record_cost(
            &mut usage,
            &json!({"cost":0,"opencode":{"billing_source":"go","list_cost":0.03}}),
        );
        assert_eq!(usage.cost_usd, Some(0.03));
        assert!(usage.cost_estimated);
        record_cost(
            &mut usage,
            &json!({"cost":0,"opencode":{"billing_source":"go"}}),
        );
        assert_eq!(usage.cost_usd, None);
    }

    #[test]
    fn actual_free_calls_and_provider_estimates_keep_their_meaning() {
        let mut usage = Usage::default();
        record_cost(
            &mut usage,
            &json!({"cost":0,"opencode":{"billing_source":"free"}}),
        );
        assert_eq!(usage.cost_usd, Some(0.0));
        assert!(!usage.cost_estimated);
        record_cost(
            &mut usage,
            &json!({"cost":0.02,"opencode":{"billing_source":"byok","estimated":true}}),
        );
        assert_eq!(usage.cost_usd, Some(0.02));
        assert!(usage.cost_estimated);
        record_cost(&mut usage, &json!({"cost":-1}));
        assert_eq!(usage.cost_usd, None);
    }
}
