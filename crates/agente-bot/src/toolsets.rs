//! Toolsets: what a bot may use, named in its `bot.toml` (`toolsets`). A set
//! names built-in tools; the runtime keeps only those for the bot's turns.
//! A bot's own tools (memory, handoffs) are always there. An empty list keeps
//! every tool, which is how bots made before toolsets keep working.

use serde::Serialize;

/// A group of tools a bot can be given, as clients list it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Toolset {
    pub id: &'static str,
    pub tools: &'static [&'static str],
}

/// Every toolset, in the order clients show them. `"mcp"` stands for the MCP
/// tools of the servers the owner approved.
pub const TOOLSETS: &[Toolset] = &[
    Toolset {
        id: "core",
        tools: &[
            "read_file",
            "list_dir",
            "find",
            "grep",
            "file_outline",
            "write_file",
            "edit_file",
            "apply_patch",
            "todo_write",
            "skill",
        ],
    },
    Toolset {
        id: "web",
        tools: &["web_search", "web_fetch"],
    },
    Toolset {
        id: "run",
        tools: &["shell", "process_list", "process_output", "process_stop"],
    },
    Toolset {
        id: "agents",
        tools: &["task", "task_output", "kill_task"],
    },
    Toolset {
        id: "mcp",
        tools: &["mcp"],
    },
];

/// The built-in tools `toolsets` allow, or `None` when the bot names none
/// (every tool). Unknown names are skipped, so a set a newer version adds
/// doesn't break an older one reading the same `bot.toml`.
pub fn tool_allowlist(toolsets: &[String]) -> Option<Vec<String>> {
    if toolsets.is_empty() {
        return None;
    }
    let mut tools: Vec<String> = Vec::new();
    for set in TOOLSETS
        .iter()
        .filter(|set| toolsets.iter().any(|name| name == set.id))
    {
        for tool in set.tools {
            if !tools.iter().any(|known| known == tool) {
                tools.push((*tool).to_string());
            }
        }
    }
    Some(tools)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(sets: &[&str]) -> Vec<String> {
        sets.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn no_toolsets_keeps_every_tool() {
        assert_eq!(tool_allowlist(&[]), None);
    }

    #[test]
    fn toolsets_name_their_tools_once() {
        let tools = tool_allowlist(&names(&["core", "web", "core"])).unwrap();
        assert!(tools.contains(&"read_file".to_string()));
        assert!(tools.contains(&"web_search".to_string()));
        assert!(!tools.contains(&"shell".to_string()));
        let reads = tools.iter().filter(|tool| *tool == "read_file").count();
        assert_eq!(reads, 1);
    }

    #[test]
    fn unknown_sets_are_skipped_and_mcp_is_a_marker() {
        assert_eq!(tool_allowlist(&names(&["documents"])), Some(Vec::new()));
        assert_eq!(tool_allowlist(&names(&["mcp"])), Some(names(&["mcp"])));
    }
}
