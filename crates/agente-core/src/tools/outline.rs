//! File outline tool — fast symbol extraction without token bloat.
//!
//! Provides structural outlines of source files across major languages:
//! - Rust (fn, struct, enum, trait, impl, type, const, macro)
//! - Python (def, async def, class)
//! - JavaScript/TypeScript (function, class, interface, type, enum, export)
//! - Go (func, type struct/interface)
//! - C/C++ (class, struct, enum, namespace, functions)
//! - Java/Kotlin/C# (class, interface, enum, methods)
//! - Markdown (headings #, ##, ###)

use super::{
    resolve_project_path, ToolCore, ToolError, ToolExecutionContext, ToolExecutionMode, ToolKind,
};

/// Arguments accepted by the `file_outline` tool.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct OutlineArgs {
    /// Path to the file to outline
    #[schemars(required)]
    #[serde(alias = "file_path", alias = "filepath", alias = "file")]
    pub path: Option<String>,
}

#[derive(Default)]
pub struct FileOutlineTool;

#[derive(Debug)]
struct OutlineSymbol {
    line: usize,
    indent: usize,
    kind: &'static str,
    signature: String,
}

impl ToolCore for FileOutlineTool {
    type Args = OutlineArgs;

    fn name(&self) -> &str {
        "file_outline"
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Extract a structural outline of symbols (functions, methods, structs, classes, enums, traits, interfaces) from a source file with line numbers, without reading the entire file content."
    }

    async fn run(
        &self,
        args: OutlineArgs,
        project_dir: &str,
        _context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let path = args
            .path
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'path' parameter".to_string()))?;

        let resolved = resolve_project_path(&path, project_dir)?;
        let resolved_str = resolved.to_string_lossy().to_string();

        let metadata = tokio::fs::metadata(&resolved).await.map_err(|e| {
            ToolError::ExecutionError(format!("Failed to read file {resolved_str}: {e}"))
        })?;
        if metadata.len() > super::MAX_READ_FILE_BYTES {
            return Err(ToolError::ExecutionError(format!(
                "File {resolved_str} is {} bytes (outline limit {}). Use grep or read_file ranges.",
                metadata.len(),
                super::MAX_READ_FILE_BYTES
            )));
        }

        let content = tokio::fs::read_to_string(&resolved).await.map_err(|e| {
            ToolError::ExecutionError(format!("Failed to read file {resolved_str}: {e}"))
        })?;

        let extension = resolved
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_lowercase();

        let symbols = extract_symbols(&content, &extension);
        if symbols.is_empty() {
            let line_count = content.lines().count();
            return Ok(format!(
                "File '{path}' has {line_count} lines, but no recognized symbol declarations were found."
            ));
        }

        let mut output = format!("Outline of '{}' ({} symbols found):\n", path, symbols.len());
        for sym in symbols.iter().take(500) {
            let pad = "  ".repeat(sym.indent);
            output.push_str(&format!(
                "  L{:>4}: {}{:<7} {}\n",
                sym.line, pad, sym.kind, sym.signature
            ));
        }
        if symbols.len() > 500 {
            output.push_str(&format!(
                "\n[... {} additional symbols omitted ...]\n",
                symbols.len() - 500
            ));
        }

        Ok(output)
    }
}

fn extract_symbols(content: &str, ext: &str) -> Vec<OutlineSymbol> {
    let mut symbols = Vec::new();

    for (idx, line) in content.lines().enumerate() {
        let line_num = idx + 1;
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("//")
            || trimmed.starts_with("/*")
            || trimmed.starts_with('#') && ext != "py" && ext != "md"
        {
            if ext == "md" && trimmed.starts_with('#') {
                let level = trimmed.chars().take_while(|&c| c == '#').count();
                let heading = trimmed.trim_start_matches('#').trim();
                symbols.push(OutlineSymbol {
                    line: line_num,
                    indent: level.saturating_sub(1),
                    kind: "heading",
                    signature: heading.to_string(),
                });
            }
            continue;
        }

        let leading_spaces = line.len() - line.trim_start().len();
        let indent_level = leading_spaces / 4;

        match ext {
            "rs" => {
                if let Some(sym) = parse_rust_line(trimmed, line_num, indent_level) {
                    symbols.push(sym);
                }
            }
            "py" => {
                if let Some(sym) = parse_python_line(trimmed, line_num, indent_level) {
                    symbols.push(sym);
                }
            }
            "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" => {
                if let Some(sym) = parse_js_ts_line(trimmed, line_num, indent_level) {
                    symbols.push(sym);
                }
            }
            "go" => {
                if let Some(sym) = parse_go_line(trimmed, line_num, indent_level) {
                    symbols.push(sym);
                }
            }
            "c" | "cpp" | "h" | "hpp" | "cc" => {
                if let Some(sym) = parse_cpp_line(trimmed, line_num, indent_level) {
                    symbols.push(sym);
                }
            }
            "java" | "cs" | "kt" | "swift" => {
                if let Some(sym) = parse_general_oop_line(trimmed, line_num, indent_level) {
                    symbols.push(sym);
                }
            }
            _ => {
                if let Some(sym) = parse_rust_line(trimmed, line_num, indent_level)
                    .or_else(|| parse_python_line(trimmed, line_num, indent_level))
                    .or_else(|| parse_js_ts_line(trimmed, line_num, indent_level))
                {
                    symbols.push(sym);
                }
            }
        }
    }

    symbols
}

fn sanitize_sig(sig: &str) -> String {
    let s = sig.trim_end_matches(['{', ';', ':']).trim();
    if s.len() > 100 {
        format!("{}…", crate::util::truncate_at_char_boundary(s, 99))
    } else {
        s.to_string()
    }
}

fn parse_rust_line(line: &str, line_num: usize, indent: usize) -> Option<OutlineSymbol> {
    let clean = line.strip_prefix("pub ").unwrap_or(line);
    let clean = clean.strip_prefix("pub(crate) ").unwrap_or(clean);
    let clean = clean.strip_prefix("pub(super) ").unwrap_or(clean);
    let clean = clean.strip_prefix("async ").unwrap_or(clean);
    let clean = clean.strip_prefix("const ").unwrap_or(clean);
    let clean = clean.strip_prefix("unsafe ").unwrap_or(clean);

    let kind = if clean.starts_with("fn ") {
        "fn"
    } else if clean.starts_with("struct ") {
        "struct"
    } else if clean.starts_with("enum ") {
        "enum"
    } else if clean.starts_with("trait ") {
        "trait"
    } else if clean.starts_with("impl ") || clean.starts_with("impl<") {
        "impl"
    } else if clean.starts_with("type ") {
        "type"
    } else if clean.starts_with("mod ") {
        "mod"
    } else if clean.starts_with("macro_rules! ") {
        "macro"
    } else {
        return None;
    };

    Some(OutlineSymbol {
        line: line_num,
        indent,
        kind,
        signature: sanitize_sig(line),
    })
}

fn parse_python_line(line: &str, line_num: usize, indent: usize) -> Option<OutlineSymbol> {
    let clean = line.strip_prefix("async ").unwrap_or(line);

    if clean.starts_with("def ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: if indent > 0 { "method" } else { "def" },
            signature: sanitize_sig(clean),
        })
    } else if clean.starts_with("class ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "class",
            signature: sanitize_sig(clean),
        })
    } else {
        None
    }
}

fn parse_js_ts_line(line: &str, line_num: usize, indent: usize) -> Option<OutlineSymbol> {
    let clean = line.strip_prefix("export ").unwrap_or(line);
    let clean = clean.strip_prefix("default ").unwrap_or(clean);
    let clean = clean.strip_prefix("async ").unwrap_or(clean);

    if clean.starts_with("function ") || clean.starts_with("function* ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "func",
            signature: sanitize_sig(clean),
        })
    } else if clean.starts_with("class ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "class",
            signature: sanitize_sig(clean),
        })
    } else if clean.starts_with("interface ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "interface",
            signature: sanitize_sig(clean),
        })
    } else if clean.starts_with("type ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "type",
            signature: sanitize_sig(clean),
        })
    } else if clean.starts_with("enum ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "enum",
            signature: sanitize_sig(clean),
        })
    } else if clean.starts_with("const ")
        && (clean.contains(" = (") || clean.contains(" = async (") || clean.contains(" =>"))
    {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "func",
            signature: sanitize_sig(clean),
        })
    } else {
        None
    }
}

fn parse_go_line(line: &str, line_num: usize, indent: usize) -> Option<OutlineSymbol> {
    if line.starts_with("func ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "func",
            signature: sanitize_sig(line),
        })
    } else if line.starts_with("type ") && (line.contains("struct") || line.contains("interface")) {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: if line.contains("struct") {
                "struct"
            } else {
                "interface"
            },
            signature: sanitize_sig(line),
        })
    } else {
        None
    }
}

fn parse_cpp_line(line: &str, line_num: usize, indent: usize) -> Option<OutlineSymbol> {
    if line.starts_with("class ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "class",
            signature: sanitize_sig(line),
        })
    } else if line.starts_with("struct ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "struct",
            signature: sanitize_sig(line),
        })
    } else if line.starts_with("namespace ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "namespace",
            signature: sanitize_sig(line),
        })
    } else if line.starts_with("enum ") || line.starts_with("enum class ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "enum",
            signature: sanitize_sig(line),
        })
    } else {
        None
    }
}

fn parse_general_oop_line(line: &str, line_num: usize, indent: usize) -> Option<OutlineSymbol> {
    let clean = line.strip_prefix("public ").unwrap_or(line);
    let clean = clean.strip_prefix("private ").unwrap_or(clean);
    let clean = clean.strip_prefix("protected ").unwrap_or(clean);
    let clean = clean.strip_prefix("static ").unwrap_or(clean);
    let clean = clean.strip_prefix("final ").unwrap_or(clean);
    let clean = clean.strip_prefix("abstract ").unwrap_or(clean);

    if clean.starts_with("class ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "class",
            signature: sanitize_sig(clean),
        })
    } else if clean.starts_with("interface ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "interface",
            signature: sanitize_sig(clean),
        })
    } else if clean.starts_with("enum ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "enum",
            signature: sanitize_sig(clean),
        })
    } else if clean.starts_with("fun ") {
        Some(OutlineSymbol {
            line: line_num,
            indent,
            kind: "fun",
            signature: sanitize_sig(clean),
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rust_symbols() {
        let code = r#"
pub struct Engine {
    speed: u32,
}

impl Engine {
    pub fn new() -> Self {
        Self { speed: 0 }
    }

    pub async fn accelerate(&mut self) -> Result<()> {
        Ok(())
    }
}

pub enum State {
    Running,
    Stopped,
}
"#;
        let syms = extract_symbols(code, "rs");
        assert_eq!(syms.len(), 5);
        assert_eq!(syms[0].kind, "struct");
        assert_eq!(syms[1].kind, "impl");
        assert_eq!(syms[2].kind, "fn");
        assert_eq!(syms[3].kind, "fn");
        assert_eq!(syms[4].kind, "enum");
    }

    #[test]
    fn parses_python_symbols() {
        let code = r#"
class Agent:
    def __init__(self):
        pass

    async def run(self):
        return True
"#;
        let syms = extract_symbols(code, "py");
        assert_eq!(syms.len(), 3);
        assert_eq!(syms[0].kind, "class");
        assert_eq!(syms[1].kind, "method");
        assert_eq!(syms[2].kind, "method");
    }

    #[test]
    fn parses_typescript_symbols() {
        let code = r#"
export interface UserConfig {
    id: string;
}

export class Service {
    start() {}
}

export const helper = async () => {};
"#;
        let syms = extract_symbols(code, "ts");
        assert_eq!(syms.len(), 3);
        assert_eq!(syms[0].kind, "interface");
        assert_eq!(syms[1].kind, "class");
        assert_eq!(syms[2].kind, "func");
    }

    /// A long signature used to be sliced at byte 99, splitting a multibyte
    /// char and panicking.
    #[test]
    fn long_unicode_signature_does_not_panic() {
        let sig = format!("fn {}()", "日".repeat(80));
        let clean = sanitize_sig(&sig);
        assert!(clean.ends_with('…'));
        assert!(clean.len() <= 102);
    }
}
