//! Tool-argument recovery: JSON parsing, alias normalization, double-encoded
//! argument unwrapping, and salvage of malformed model-emitted arguments.

/// JSON key under which unparsable raw arguments are preserved for salvage.
pub(crate) const RAW_TOOL_ARGUMENTS_KEY: &str = "__raw_tool_arguments";

pub(crate) fn parse_tool_args(args_str: &str) -> serde_json::Value {
    let mut value = serde_json::from_str(args_str)
        .unwrap_or_else(|_| serde_json::json!({ RAW_TOOL_ARGUMENTS_KEY: args_str }));
    for _ in 0..2 {
        let Some(inner) = value.as_str().map(str::trim) else {
            break;
        };
        if !(inner.starts_with('{') || inner.starts_with('[')) {
            break;
        }
        value = serde_json::from_str(inner)
            .unwrap_or_else(|_| serde_json::json!({ RAW_TOOL_ARGUMENTS_KEY: inner }));
    }
    value
}

pub(crate) fn normalize_tool_args(
    tool_name: &str,
    mut args: serde_json::Value,
) -> serde_json::Value {
    if let Some(raw) = args.get(RAW_TOOL_ARGUMENTS_KEY).and_then(|v| v.as_str()) {
        if let Some(recovered) = recover_malformed_tool_args(tool_name, raw) {
            return recovered;
        }
    }

    args = unwrap_nested_tool_args(args);
    let Some(obj) = args.as_object_mut() else {
        return args;
    };

    normalize_alias(
        obj,
        "path",
        &[
            "file_path",
            "filePath",
            "filepath",
            "file",
            "filename",
            "file_name",
            "fileName",
        ],
    );

    match tool_name {
        "write_file" => {
            normalize_alias(
                obj,
                "content",
                &[
                    "text",
                    "data",
                    "body",
                    "contents",
                    "file_content",
                    "fileContent",
                    "value",
                ],
            );
        }
        "edit_file" => {
            normalize_alias(
                obj,
                "search",
                &["old", "old_text", "oldText", "oldString", "old_string"],
            );
            normalize_alias(
                obj,
                "replace",
                &["new", "new_text", "newText", "newString", "new_string"],
            );
        }
        "shell" => {
            normalize_alias(obj, "command", &["cmd", "script"]);
        }
        "grep" => {
            normalize_alias(obj, "pattern", &["query", "regex"]);
        }
        "apply_patch" => {
            normalize_alias(obj, "patch", &["diff", "unified_diff", "content"]);
            let has_path = obj
                .get("path")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .is_some_and(|s| !s.is_empty());
            if !has_path {
                if let Some(patch_text) = obj.get("patch").and_then(|v| v.as_str()) {
                    if let Some(extracted) =
                        crate::tools::patch::extract_target_file_from_patch(patch_text)
                    {
                        obj.insert("path".to_string(), serde_json::Value::String(extracted));
                    }
                }
            }
        }
        _ => {}
    }

    args
}

pub(crate) fn recover_malformed_tool_args(tool_name: &str, raw: &str) -> Option<serde_json::Value> {
    let mut obj = serde_json::Map::new();
    match tool_name {
        "write_file" => {
            insert_first_string(
                &mut obj,
                "path",
                raw,
                &["path", "filePath", "file_path", "filename"],
            );
            insert_first_string(
                &mut obj,
                "content",
                raw,
                &["content", "fileContent", "file_content", "contents", "text"],
            );
        }
        "edit_file" => {
            insert_first_string(
                &mut obj,
                "path",
                raw,
                &["path", "filePath", "file_path", "filename"],
            );
            insert_first_string(
                &mut obj,
                "search",
                raw,
                &["search", "old", "oldText", "old_text"],
            );
            insert_first_string(
                &mut obj,
                "replace",
                raw,
                &["replace", "new", "newText", "new_text"],
            );
        }
        "shell" => {
            insert_first_string(&mut obj, "command", raw, &["command", "cmd", "script"]);
        }
        "apply_patch" => {
            insert_first_string(
                &mut obj,
                "path",
                raw,
                &["path", "filePath", "file_path", "filename"],
            );
            insert_first_string(&mut obj, "patch", raw, &["patch", "diff", "unified_diff"]);
        }
        "file_outline" => {
            insert_first_string(
                &mut obj,
                "path",
                raw,
                &["path", "filePath", "file_path", "filename"],
            );
        }
        _ => return None,
    }

    if obj.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(obj))
    }
}

fn insert_first_string(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    canonical: &str,
    raw: &str,
    aliases: &[&str],
) {
    for alias in aliases {
        if let Some(value) = extract_jsonish_string_field(raw, alias) {
            obj.insert(canonical.to_string(), serde_json::Value::String(value));
            return;
        }
    }
}

fn extract_jsonish_string_field(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let key_pos = raw.find(&needle)?;
    let after_key = &raw[key_pos + needle.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();

    if let Some(rest) = after_colon.strip_prefix('"') {
        let mut escaped = false;
        let mut last_quote = None;
        for (idx, ch) in rest.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '"' => {
                    last_quote = Some(idx);
                    let tail = rest[idx + 1..].trim_start();
                    if tail.starts_with(',') || tail.starts_with('}') || tail.is_empty() {
                        break;
                    }
                }
                _ => {}
            }
        }
        let end = last_quote.unwrap_or(rest.len());
        let quoted = format!("\"{}\"", &rest[..end]);
        return serde_json::from_str::<String>(&quoted)
            .ok()
            .or_else(|| Some(rest[..end].replace("\\\"", "\"").replace("\\n", "\n")));
    }

    let end = after_colon.find([',', '}']).unwrap_or(after_colon.len());
    let value = after_colon[..end].trim().trim_matches('"');
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn unwrap_nested_tool_args(mut args: serde_json::Value) -> serde_json::Value {
    for key in ["input", "args", "arguments", "parameters"] {
        if args.get(key).is_some() && args.as_object().map(|o| o.len() == 1).unwrap_or(false) {
            if let Some(nested) = args.get(key).cloned() {
                args = nested;
            }
        }
    }
    args
}

pub(crate) fn normalize_alias(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    canonical: &str,
    aliases: &[&str],
) {
    if obj.contains_key(canonical) {
        return;
    }

    for alias in aliases {
        if let Some(value) = obj.remove(*alias) {
            obj.insert(canonical.to_string(), value);
            return;
        }
    }
}
