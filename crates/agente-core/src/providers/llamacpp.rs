//! llama-server thinking detection, shared by every client.
//!
//! `/props` has no `supports_thinking` flag, so — like llama.cpp's own WebUI
//! (`tools/ui/src/lib/utils/chat-template-thinking-detector.ts`) — support is
//! read from the chat template the server actually loaded. Servers new enough
//! to report `chat_template_caps` also take thinking per request
//! (`chat_template_kwargs.enable_thinking`, `thinking_budget_tokens`) and say
//! whether the template reads `reasoning_effort`.

use std::sync::OnceLock;

use regex::Regex;

use super::{join_url, ModelInfo, ProviderInfo};
use crate::catalog::ReasoningOption;
use crate::thinking::ThinkingFormat;

/// Whether a provider is a llama-server: its spec says so, or its thinking
/// shape resolves to llama.cpp.
pub(crate) fn is_llamacpp(info: &ProviderInfo) -> bool {
    super::spec::get(&info.id)
        .is_some_and(|spec| spec.models == super::spec::ModelSource::Llamacpp)
        || crate::thinking::detect_thinking_format(&info.id, &info.base_url)
            == ThinkingFormat::LlamaCpp
}

const THINKING_KWARGS: &[&str] = &["enable_thinking", "reasoning_effort", "thinking_budget"];

/// Paired thinking tags (Kimi-K2 / Gemma 4's fixed-length pair is the
/// self-closing `<think></think>`).
const THINKING_TAGS: &[(&str, Option<&str>)] = &[
    ("<think>", Some("</think>")),
    ("<|channel>thought", Some("<|channel|>")),
    ("<|think|>", Some("</|think|>")),
    ("<seed:think|>", Some("</seed:think|>")),
    ("<think></think>", None),
];

fn patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let mut patterns: Vec<Regex> = THINKING_KWARGS
            .iter()
            .map(|kwarg| {
                Regex::new(&format!(
                    r"(?i)(\{{\{{[^{{}}]*\b{kwarg}\b[^{{}}]*\}}\}}|\{{%[^{{}}]*\b{kwarg}\b[^{{}}]*%\}})"
                ))
                .expect("kwarg pattern")
            })
            .collect();
        for conditional in [
            r"(?i)\{%-?\s*if\s+\(?\s*\w*enable[\s_]+\w*(thinking|think|reasoning)",
            r"(?i)\{%-?\s*if\s+\w*(thinking|reasoning)\s*(is not|==|!=)",
            r"(?i)\{%-?\s*if\s+not\s+\w*enable",
            r"(?i)\{%-?\s*if\s+ns\.enable_thinking",
        ] {
            patterns.push(Regex::new(conditional).expect("conditional pattern"));
        }
        patterns
    })
}

/// Whether a chat template can think: thinking kwargs, thinking conditionals,
/// or paired thinking tags. Guards against "chain of thought" in tool text.
pub fn template_supports_thinking(template: &str) -> bool {
    if template.is_empty() {
        return false;
    }
    patterns().iter().any(|re| re.is_match(template))
        || THINKING_TAGS
            .iter()
            .any(|(start, end)| template.contains(start) && end.is_none_or(|e| template.contains(e)))
}

/// The thinking option a `/props` response grants, `None` when the loaded
/// template cannot think.
pub fn option_from_props(props: &serde_json::Value) -> Option<ReasoningOption> {
    let template = props
        .get("chat_template")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let caps = props
        .get("chat_template_caps")
        .and_then(serde_json::Value::as_object);
    let effort_kwarg = caps
        .and_then(|caps| caps.get("supports_reasoning_effort"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !template_supports_thinking(template) && !effort_kwarg {
        return None;
    }
    Some(ReasoningOption::LlamaCpp {
        per_request: caps.is_some(),
        effort_kwarg,
    })
}

/// The thinking profile a chat template grants before a server has loaded it
/// (Agente Desktop reads the GGUF's template without launching llama-server).
/// Without `/props` the server version is unknown, so only on/off is offered.
pub fn template_profile(template: &str) -> crate::thinking::ThinkingProfile {
    let mut model = super::fallback_model_info("llamacpp", "template");
    model.compat = ThinkingFormat::LlamaCpp;
    if let Some(option) = option_from_props(&serde_json::json!({ "chat_template": template })) {
        model.capabilities.reasoning = true;
        model.reasoning_options = vec![option];
    }
    crate::thinking::profile(&model)
}

/// `GET /props` on the server behind an OpenAI-style base URL (`…/v1`).
async fn fetch_props(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
) -> Option<serde_json::Value> {
    let root = base_url.trim_end_matches('/');
    let root = root.strip_suffix("/v1").unwrap_or(root);
    let mut request = client.get(join_url(root, "props"));
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), request.send())
        .await
        .ok()?
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

/// Give every listed model the thinking controls the server's template grants.
/// A server that does not answer `/props` leaves the list untouched.
pub(crate) async fn attach_props(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    models: &mut [ModelInfo],
) {
    let Some(props) = fetch_props(client, base_url, api_key).await else {
        return;
    };
    let option = option_from_props(&props);
    for model in models {
        model.compat = ThinkingFormat::LlamaCpp;
        if let Some(option) = &option {
            model.capabilities.reasoning = true;
            model.reasoning_options = vec![option.clone()];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_kwargs_conditionals_and_tags() {
        assert!(template_supports_thinking(
            "{%- if enable_thinking is defined and enable_thinking is false %}<think>\n\n</think>{% endif %}"
        ));
        assert!(template_supports_thinking("{{ reasoning_effort }}"));
        assert!(template_supports_thinking("<think>{{ content }}</think>"));
        assert!(template_supports_thinking("<think></think>"));
        assert!(!template_supports_thinking(
            "Use chain of thought. <|im_start|>{{ message.content }}<|im_end|>"
        ));
        assert!(!template_supports_thinking(""));
    }

    #[test]
    fn template_profile_offers_on_off_until_the_server_answers() {
        let profile = template_profile("<think>{{ x }}</think>");
        assert_eq!(profile.ids(), vec!["off", "on"]);
        assert!(template_profile("{{ messages }}").levels.is_empty());
    }

    #[test]
    fn props_decide_per_request_control_and_effort() {
        let new_server = serde_json::json!({
            "chat_template": "{% if enable_thinking %}<think>{% endif %}</think>",
            "chat_template_caps": { "supports_reasoning_effort": true }
        });
        assert_eq!(
            option_from_props(&new_server),
            Some(ReasoningOption::LlamaCpp {
                per_request: true,
                effort_kwarg: true
            })
        );
        let old_server = serde_json::json!({ "chat_template": "<think>x</think>" });
        assert_eq!(
            option_from_props(&old_server),
            Some(ReasoningOption::LlamaCpp {
                per_request: false,
                effort_kwarg: false
            })
        );
        let plain = serde_json::json!({
            "chat_template": "{{ messages }}",
            "chat_template_caps": { "supports_reasoning_effort": false }
        });
        assert_eq!(option_from_props(&plain), None);
    }
}
