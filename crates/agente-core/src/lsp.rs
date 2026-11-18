//! Post-write syntax diagnostics.

use serde_json::Value;
use std::path::Path;

/// Syntax checks that are actually parsing, not guessing.
///
/// There used to be a hand-rolled Rust brace counter here. It did not skip
/// comments, raw strings, escapes or lifetimes (`&'a str` opened a "string"
/// that swallowed braces), so it reported "Unbalanced braces: 2 extra opening"
/// on files that compiled — a false diagnostic is worse than no diagnostic,
/// because the model then "fixes" working code. Rust syntax is the compiler's
/// business (`cargo check`), and a configured language server is the only
/// source allowed to call something an error.
pub fn quick_validate_syntax(file_path: &str, content: &str) -> Vec<String> {
    let mut errors = Vec::new();
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    if ext == "json" {
        quick_validate_json(content, &mut errors);
    }

    errors
}

fn quick_validate_json(content: &str, errors: &mut Vec<String>) {
    match serde_json::from_str::<Value>(content) {
        Ok(_) => {}
        Err(e) => {
            errors.push(format!("JSON parse error: {e}"));
        }
    }
}
