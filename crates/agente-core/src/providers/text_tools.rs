//! Tool calls a model wrote into its reply as text.
//!
//! Some open models served through an OpenAI-compatible endpoint (MiMo, Qwen
//! and friends behind a gateway that does not run the model's tool parser)
//! answer with the call spelled out in `content` instead of `tool_calls`:
//!
//! ```text
//! <tool_call>{"name": "read", "arguments": {"path": "a.rs"}}</tool_call>
//! <tool_call><function=read><parameter=path>a.rs</parameter></function></tool_call>
//! ```
//!
//! Left alone, that markup is shown to the user as the reply and the call never
//! runs. `TextToolFilter` sits on the text stream: ordinary prose passes
//! through, a recognised call is held back and returned parsed, and anything
//! that opens like a call but does not parse is handed back unchanged.

use serde_json::{json, Map, Value};

const OPENERS: [&str; 2] = ["<tool_call>", "<function="];

#[derive(Debug, Clone, PartialEq)]
pub struct TextToolCall {
    pub name: String,
    /// The arguments as a JSON object string.
    pub args: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct Filtered {
    /// Text safe to show.
    pub text: String,
    pub calls: Vec<TextToolCall>,
}

#[derive(Default)]
pub struct TextToolFilter {
    pending: String,
    capturing: bool,
}

impl TextToolFilter {
    pub fn push(&mut self, chunk: &str) -> Filtered {
        self.pending.push_str(chunk);
        let mut out = Filtered::default();
        loop {
            if self.capturing {
                let Some((end, _)) = closing(&self.pending) else {
                    break;
                };
                let block: String = self.pending.drain(..end).collect();
                self.capturing = false;
                settle(&block, &mut out);
                continue;
            }
            match earliest_opener(&self.pending) {
                Some(at) => {
                    out.text.push_str(&self.pending[..at]);
                    self.pending.drain(..at);
                    self.capturing = true;
                }
                None => {
                    let keep = partial_opener_suffix(&self.pending);
                    let cut = self.pending.len() - keep;
                    out.text.push_str(&self.pending[..cut]);
                    self.pending.drain(..cut);
                    break;
                }
            }
        }
        out
    }

    /// End of stream: whatever is still held is either a call missing its
    /// closing tag or plain text.
    pub fn finish(&mut self) -> Filtered {
        let mut out = Filtered::default();
        let rest = std::mem::take(&mut self.pending);
        self.capturing = false;
        if !rest.is_empty() {
            settle(&rest, &mut out);
        }
        out
    }
}

fn settle(block: &str, out: &mut Filtered) {
    match parse_block(block) {
        Some(calls) if !calls.is_empty() => out.calls.extend(calls),
        _ => out.text.push_str(block),
    }
}

fn earliest_opener(text: &str) -> Option<usize> {
    OPENERS.iter().filter_map(|opener| text.find(opener)).min()
}

/// Longest tail of `text` that could still grow into an opener.
fn partial_opener_suffix(text: &str) -> usize {
    let mut best = 0;
    for opener in OPENERS {
        for len in (1..opener.len()).rev() {
            if len <= best || len > text.len() {
                continue;
            }
            if text.is_char_boundary(text.len() - len) && text.ends_with(&opener[..len]) {
                best = len;
                break;
            }
        }
    }
    best
}

/// Where the captured block ends: after `</tool_call>` when it opened with
/// one, otherwise after the last `</function>`.
fn closing(text: &str) -> Option<(usize, &'static str)> {
    if text.starts_with("<tool_call>") {
        let end = "</tool_call>";
        return text.find(end).map(|at| (at + end.len(), end));
    }
    let end = "</function>";
    text.find(end).map(|at| (at + end.len(), end))
}

fn parse_block(block: &str) -> Option<Vec<TextToolCall>> {
    let inner = block.trim();
    let inner = inner.strip_prefix("<tool_call>").unwrap_or(inner);
    let inner = inner.strip_suffix("</tool_call>").unwrap_or(inner).trim();
    if inner.starts_with('{') || inner.starts_with('[') {
        return parse_json(inner);
    }
    let calls = parse_functions(inner);
    (!calls.is_empty()).then_some(calls)
}

fn parse_json(inner: &str) -> Option<Vec<TextToolCall>> {
    let value: Value = serde_json::from_str(inner).ok()?;
    let items = match value {
        Value::Array(items) => items,
        other => vec![other],
    };
    let calls: Vec<_> = items.iter().filter_map(json_call).collect();
    (!calls.is_empty()).then_some(calls)
}

fn json_call(value: &Value) -> Option<TextToolCall> {
    let object = value.as_object()?;
    let function = object.get("function").and_then(Value::as_object);
    let name = object
        .get("name")
        .or_else(|| function.and_then(|f| f.get("name")))?
        .as_str()?
        .trim();
    if name.is_empty() {
        return None;
    }
    let arguments = object
        .get("arguments")
        .or_else(|| object.get("parameters"))
        .or_else(|| function.and_then(|f| f.get("arguments")))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let args = match arguments {
        // Often a JSON document inside a string.
        Value::String(text) => match serde_json::from_str::<Value>(&text) {
            Ok(parsed @ Value::Object(_)) => parsed.to_string(),
            _ => return None,
        },
        object @ Value::Object(_) => object.to_string(),
        _ => return None,
    };
    Some(TextToolCall {
        name: name.to_string(),
        args,
    })
}

/// `<function=NAME><parameter=KEY>VALUE</parameter>…</function>`, any number
/// of times.
fn parse_functions(text: &str) -> Vec<TextToolCall> {
    let mut calls = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<function=") {
        let after = &rest[start + "<function=".len()..];
        let Some(name_end) = after.find('>') else {
            break;
        };
        let name = after[..name_end].trim().trim_matches('"');
        let body_start = &after[name_end + 1..];
        let (body, next) = match body_start.find("</function>") {
            Some(end) => (&body_start[..end], &body_start[end + "</function>".len()..]),
            None => (body_start, ""),
        };
        if !name.is_empty() {
            calls.push(TextToolCall {
                name: name.to_string(),
                args: Value::Object(parse_parameters(body)).to_string(),
            });
        }
        rest = next;
    }
    calls
}

fn parse_parameters(body: &str) -> Map<String, Value> {
    let mut args = Map::new();
    let mut rest = body;
    while let Some(start) = rest.find("<parameter=") {
        let after = &rest[start + "<parameter=".len()..];
        let Some(key_end) = after.find('>') else {
            break;
        };
        let key = after[..key_end].trim().trim_matches('"').to_string();
        let value_start = &after[key_end + 1..];
        let (raw, next) = match value_start.find("</parameter>") {
            Some(end) => (
                &value_start[..end],
                &value_start[end + "</parameter>".len()..],
            ),
            None => (value_start, ""),
        };
        if !key.is_empty() {
            args.insert(key, parameter_value(raw));
        }
        rest = next;
    }
    args
}

/// Parameter values are text; structured and numeric ones are read back as
/// such. The single newline each side of a multi-line value is markup.
fn parameter_value(raw: &str) -> Value {
    let text = raw.strip_prefix('\n').unwrap_or(raw);
    let text = text.strip_suffix('\n').unwrap_or(text);
    let trimmed = text.trim();
    let structured = matches!(trimmed.as_bytes().first(), Some(b'{' | b'['))
        || matches!(trimmed, "true" | "false" | "null")
        || (!trimmed.is_empty()
            && trimmed.len() < 16
            && trimmed.parse::<f64>().is_ok()
            && !trimmed.starts_with('0')
            || trimmed == "0");
    if structured {
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            return value;
        }
    }
    Value::String(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&str]) -> Filtered {
        let mut filter = TextToolFilter::default();
        let mut all = Filtered::default();
        for chunk in chunks {
            let part = filter.push(chunk);
            all.text.push_str(&part.text);
            all.calls.extend(part.calls);
        }
        let tail = filter.finish();
        all.text.push_str(&tail.text);
        all.calls.extend(tail.calls);
        all
    }

    #[test]
    fn prose_passes_through_untouched() {
        let out = run(&["Hello ", "there, <b>friend</b>."]);
        assert_eq!(out.text, "Hello there, <b>friend</b>.");
        assert!(out.calls.is_empty());
    }

    #[test]
    fn json_call_is_extracted_even_when_split_across_chunks() {
        let out = run(&[
            "Let me look.\n<tool",
            "_call>\n{\"name\":\"read\",\"argu",
            "ments\":{\"path\":\"a.rs\"}}\n</tool_call>",
        ]);
        assert_eq!(out.text, "Let me look.\n");
        assert_eq!(
            out.calls,
            vec![TextToolCall {
                name: "read".into(),
                args: json!({"path": "a.rs"}).to_string()
            }]
        );
    }

    #[test]
    fn xml_call_with_typed_parameters() {
        let out = run(&["<tool_call>\n<function=grep>\n<parameter=pattern>\nfoo(\n</parameter>\n<parameter=limit>20</parameter>\n</function>\n</tool_call>"]);
        assert_eq!(out.text, "");
        assert_eq!(out.calls.len(), 1);
        let args: Value = serde_json::from_str(&out.calls[0].args).unwrap();
        assert_eq!(args, json!({"pattern": "foo(", "limit": 20}));
    }

    #[test]
    fn several_calls_in_one_reply() {
        let out = run(&["<tool_call>{\"name\":\"a\",\"arguments\":{}}</tool_call><tool_call>{\"name\":\"b\",\"arguments\":\"{\\\"x\\\":1}\"}</tool_call>"]);
        assert_eq!(
            out.calls
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(out.calls[1].args, json!({"x": 1}).to_string());
    }

    #[test]
    fn unparseable_block_is_shown_not_swallowed() {
        let out = run(&["see <tool_call>not json</tool_call> ok"]);
        assert_eq!(out.text, "see <tool_call>not json</tool_call> ok");
        assert!(out.calls.is_empty());
    }

    #[test]
    fn bare_function_block_and_missing_close_tag() {
        let out = run(&["<function=ls><parameter=path>.</parameter></function>"]);
        assert_eq!(out.calls[0].name, "ls");
        let out = run(&["<tool_call><function=ls><parameter=path>.</parameter></function>"]);
        assert_eq!(out.calls[0].name, "ls");
    }

    #[test]
    fn held_back_partial_opener_is_released_when_it_is_not_one() {
        let out = run(&["a <tool", " b"]);
        assert_eq!(out.text, "a <tool b");
    }

    #[test]
    fn strings_that_look_numeric_with_leading_zero_stay_strings() {
        assert_eq!(parameter_value("007"), json!("007"));
        assert_eq!(parameter_value("42"), json!(42));
    }
}
