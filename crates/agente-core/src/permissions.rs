//! Permission system for fine-grained access control
//!
//! A flexible rule-based permission system:
//! - `Permission`: Allow/Deny/Ask for actions
//! - `PermissionRule`: Pattern-based rules for matching actions
//! - `PermissionEngine`: Evaluates permissions against rules

use std::sync::{Arc, RwLock};

use crate::config::AutoApproveConfig;
use crate::types::{AgentMode, ApprovalAction, ApprovalRequest};

/// Permission decision for an action
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    /// Allow the action without prompting
    Allow,
    /// Deny the action
    Deny,
    /// Ask the user for confirmation
    Ask,
}

/// Permission rule with pattern matching
#[derive(Debug, Clone)]
pub struct PermissionRule {
    /// Pattern to match (e.g., "file:write", "tool:bash", "file:**/*.toml")
    pub pattern: String,
    /// Permission decision for matching actions
    pub permission: Permission,
}

impl PermissionRule {
    /// Create a new permission rule
    pub fn new(pattern: impl Into<String>, permission: Permission) -> Self {
        Self {
            pattern: pattern.into(),
            permission,
        }
    }

    /// Check if an action matches this rule's pattern
    pub fn matches(&self, action: &str) -> bool {
        // Support wildcards: * matches any sequence of characters, ** matches including /
        // Exact match
        if self.pattern == action {
            return true;
        }

        // Wildcard matching
        if self.pattern.contains('*') {
            return match_wildcard(&self.pattern, action);
        }

        // Prefix match (e.g., "tool:" matches all tools)
        if self.pattern.ends_with(':') {
            return action.starts_with(&self.pattern);
        }

        false
    }
}

#[derive(Debug, Clone, Copy)]
enum GlobToken {
    Lit(char),
    /// `*` — zero or more characters except `/`.
    Star,
    /// `**` — zero or more characters including `/`.
    DoubleStar,
    /// `**/` — zero or more directory segments (empty or any prefix ending in `/`).
    DoubleStarSlash,
}

fn tokenize_wildcard(pattern: &str) -> Vec<GlobToken> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut tokens = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' {
            let start = i;
            while i < chars.len() && chars[i] == '*' {
                i += 1;
            }
            if i - start >= 2 {
                if i < chars.len() && chars[i] == '/' {
                    tokens.push(GlobToken::DoubleStarSlash);
                    i += 1;
                } else {
                    tokens.push(GlobToken::DoubleStar);
                }
            } else {
                tokens.push(GlobToken::Star);
            }
        } else {
            tokens.push(GlobToken::Lit(chars[i]));
            i += 1;
        }
    }
    tokens
}

fn match_wildcard(pattern: &str, action: &str) -> bool {
    let tokens = tokenize_wildcard(pattern);
    let act: Vec<char> = action.chars().collect();
    let n = act.len();
    let mut dp = vec![false; n + 1];
    dp[0] = true;

    for token in tokens {
        let mut next = vec![false; n + 1];
        match token {
            GlobToken::Lit(ch) => {
                for j in 1..=n {
                    if dp[j - 1] && act[j - 1] == ch {
                        next[j] = true;
                    }
                }
            }
            GlobToken::Star => {
                next.copy_from_slice(&dp);
                for j in 1..=n {
                    if act[j - 1] != '/' && next[j - 1] {
                        next[j] = true;
                    }
                }
            }
            GlobToken::DoubleStar => {
                next.copy_from_slice(&dp);
                for j in 1..=n {
                    if next[j - 1] {
                        next[j] = true;
                    }
                }
            }
            GlobToken::DoubleStarSlash => {
                next.copy_from_slice(&dp);
                let mut seen = dp[0];
                for j in 1..=n {
                    if seen && act[j - 1] == '/' {
                        next[j] = true;
                    }
                    if dp[j] {
                        seen = true;
                    }
                }
            }
        }
        dp = next;
    }

    dp[n]
}

/// Default permission rules for Plan mode
pub fn plan_mode_default_rules() -> Vec<PermissionRule> {
    vec![
        // Read operations are allowed
        PermissionRule::new("tool:read_file", Permission::Allow),
        PermissionRule::new("tool:list_dir", Permission::Allow),
        PermissionRule::new("tool:grep", Permission::Allow),
        PermissionRule::new("tool:find", Permission::Allow),
        PermissionRule::new("tool:file_outline", Permission::Allow),
        PermissionRule::new("tool:todo_write", Permission::Allow),
        // Looking things up changes nothing: web reads, and the output of
        // background processes started earlier in Build mode.
        PermissionRule::new("tool:web_fetch", Permission::Allow),
        PermissionRule::new("tool:web_search", Permission::Allow),
        PermissionRule::new("tool:process_list", Permission::Allow),
        PermissionRule::new("tool:process_output", Permission::Allow),
        // Loading a skill only reads its instructions.
        PermissionRule::new("tool:skill", Permission::Allow),
        // Subagent orchestration is safe in Plan mode: the host coerces every
        // child to read-only tools, so spawning research children is the
        // intended way to explore before presenting a plan.
        PermissionRule::new("tool:task", Permission::Allow),
        PermissionRule::new("tool:task_output", Permission::Allow),
        PermissionRule::new("tool:kill_task", Permission::Allow),
        // Cross-driver orchestrator tools are also allowed in Plan mode; the
        // orchestrator clamps delegated children to the parent's Plan ceiling.
        PermissionRule::new("tool:orchestrator_*", Permission::Allow),
        // Present finished plan for Accept / Redo / Comment (writes only under .agente/plans/)
        PermissionRule::new("tool:present_plan", Permission::Allow),
        // Mutating operations are denied in Plan mode. Switch to Build mode to edit.
        PermissionRule::new("tool:write_file", Permission::Deny),
        PermissionRule::new("tool:edit_file", Permission::Deny),
        // Shell commands are denied in Plan mode.
        PermissionRule::new("tool:shell", Permission::Deny),
    ]
}

/// Default permission rules for Build mode
pub fn build_mode_default_rules() -> Vec<PermissionRule> {
    vec![
        // Most operations allowed
        PermissionRule::new("tool:read_file", Permission::Allow),
        PermissionRule::new("tool:list_dir", Permission::Allow),
        PermissionRule::new("tool:grep", Permission::Allow),
        PermissionRule::new("tool:todo_write", Permission::Allow),
        // Loading a skill only reads its instructions.
        PermissionRule::new("tool:skill", Permission::Allow),
        PermissionRule::new("tool:present_plan", Permission::Allow),
        // Hosted subagent lifecycle is always allowed; child capability modes
        // (not the parent mode) constrain what a child may do.
        PermissionRule::new("tool:task", Permission::Allow),
        PermissionRule::new("tool:task_output", Permission::Allow),
        PermissionRule::new("tool:kill_task", Permission::Allow),
        // Write/edit tools still pass through check_tool's explicit Ask check
        // (currently Allow — approval is decided per-call by the dangerous heuristic
        // in the channel layer).
        PermissionRule::new("tool:write_file", Permission::Allow),
        PermissionRule::new("tool:edit_file", Permission::Allow),
        // Every shell command in Build mode requires user approval.
        PermissionRule::new("tool:shell", Permission::Ask),
    ]
}

/// Permission engine for evaluating access control
#[derive(Debug, Clone)]
pub struct PermissionEngine {
    rules: Vec<PermissionRule>,
    /// Current agent mode
    pub mode: AgentMode,
    /// User preference for auto-approve
    auto_approve_all: bool,
    /// Fine-grained auto-approve rules loaded from config.
    auto_approve_config: Option<AutoApproveConfig>,
    /// Project directory used to resolve relative paths for config checks.
    project_dir: Option<std::path::PathBuf>,
}

impl PermissionEngine {
    /// Create a new permission engine with the given mode
    pub fn new(mode: AgentMode) -> Self {
        let rules = match mode {
            AgentMode::Plan => plan_mode_default_rules(),
            AgentMode::Build => build_mode_default_rules(),
        };

        Self {
            rules,
            mode,
            auto_approve_all: false,
            auto_approve_config: None,
            project_dir: None,
        }
    }

    /// Set the agent mode
    pub fn set_mode(&mut self, mode: AgentMode) {
        self.mode = mode;
        self.rules = match mode {
            AgentMode::Plan => plan_mode_default_rules(),
            AgentMode::Build => build_mode_default_rules(),
        };
    }

    /// Set auto-approve preference
    pub fn set_auto_approve(&mut self, auto_approve: bool) {
        self.auto_approve_all = auto_approve;
    }

    /// Get current auto-approve setting
    pub fn auto_approve(&self) -> bool {
        self.auto_approve_all
    }

    /// Add a permission rule
    pub fn add_rule(&mut self, rule: PermissionRule) {
        self.rules.push(rule);
    }

    /// Create a permission engine seeded with the user's auto-approve config.
    pub fn from_config(mode: AgentMode, config: &AutoApproveConfig) -> Self {
        let mut engine = Self::new(mode);
        engine.auto_approve_config = Some(config.clone());
        engine
    }

    /// Set the project directory used to resolve relative tool paths.
    pub fn with_project_dir(mut self, project_dir: impl Into<std::path::PathBuf>) -> Self {
        self.project_dir = Some(project_dir.into());
        self
    }
}

/// Filesystem facts a permission rule may need. Collected BEFORE acquiring the
/// engine lock (see [`collect_fs_facts`]) so slow disks never stall other
/// permission decisions or the async runtime while the lock is held.
#[derive(Debug, Clone, Copy, Default)]
pub struct ToolFsFacts {
    /// Whether the write/edit target currently exists.
    pub target_exists: bool,
    /// Line count of the edit target (`None` when unreadable or not text).
    pub target_line_count: Option<usize>,
}

/// Read the filesystem facts the config rules rely on. No locks held here.
pub fn collect_fs_facts(
    tool_name: &str,
    args: &serde_json::Value,
    project_dir: Option<&std::path::Path>,
) -> ToolFsFacts {
    let mut facts = ToolFsFacts::default();
    let Some(path) = args.get("path").and_then(|v| v.as_str()) else {
        return facts;
    };
    let target = project_dir
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(path);
    match tool_name {
        "write_file" => facts.target_exists = target.exists(),
        "edit_file" => {
            facts.target_exists = target.exists();
            facts.target_line_count = std::fs::read_to_string(&target)
                .ok()
                .map(|c| c.lines().count());
        }
        _ => {}
    }
    facts
}

impl PermissionEngine {
    /// Apply fine-grained config rules to a Build-mode tool request using
    /// pre-collected filesystem facts (no I/O under the caller's lock).
    fn check_config_rule(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        facts: &ToolFsFacts,
    ) -> Option<Permission> {
        let config = self.auto_approve_config.as_ref()?;
        if self.mode != AgentMode::Build {
            return None;
        }

        match tool_name {
            "shell" => {
                let command = args.get("command").and_then(|v| v.as_str())?;
                if is_dangerous_command(command) {
                    return Some(Permission::Ask);
                }
                // A safe command pointed outside the project (`ls /etc`,
                // `cat ~/.ssh/id_rsa`, `git -C ..`) is no longer safe.
                if !shell_outside_paths(command, self.project_dir.as_deref()).is_empty() {
                    return Some(Permission::Ask);
                }
                if !shell_composes(command)
                    && config.safe_commands.iter().any(|safe| {
                        command == safe
                            || command
                                .strip_prefix(safe.as_str())
                                .map(|rest| rest.is_empty() || rest.starts_with(' '))
                                .unwrap_or(false)
                    })
                {
                    return Some(Permission::Allow);
                }
                Some(Permission::Ask)
            }
            // Files that configure what runs next (git hooks, MCP servers,
            // agent/skill definitions, project config) never ride on the
            // small-edit or new-file allowance: a few lines there are code
            // execution on the next start.
            "write_file" | "edit_file" | "apply_patch"
                if args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .is_some_and(is_protected_path) =>
            {
                Some(Permission::Ask)
            }
            "write_file" => {
                // Require the path key for parity with the rule contract; the
                // existence fact was collected lock-free.
                args.get("path").and_then(|v| v.as_str())?;
                if !facts.target_exists && config.write_new_files {
                    return Some(Permission::Allow);
                }
                Some(Permission::Ask)
            }
            "edit_file" => {
                args.get("path").and_then(|v| v.as_str())?;
                if let Some(lines) = facts.target_line_count {
                    if lines <= config.max_auto_edit_lines {
                        return Some(Permission::Allow);
                    }
                }
                Some(Permission::Ask)
            }
            // `apply_patch` infers its targets from patch headers, so the
            // argument-level facts the other rules rely on are unavailable.
            // Always ask rather than fall through to the mode default allow.
            "apply_patch" => Some(Permission::Ask),
            _ => None,
        }
    }

    /// Check permission for a tool call. Convenience form: collects the
    /// filesystem facts inline (I/O happens under the caller's lock — prefer
    /// [`PermissionEngine::check_tool_with_default`] on hot paths).
    pub fn check_tool(&self, tool_name: &str, args: &serde_json::Value) -> Permission {
        self.check_tool_or(tool_name, args, None)
    }

    /// [`Self::check_tool`] with the tool's own fallback permission
    /// ([`crate::tools::Tool::default_permission`]).
    pub fn check_tool_or(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        tool_default: Option<Permission>,
    ) -> Permission {
        let facts = collect_fs_facts(tool_name, args, self.project_dir.as_deref());
        self.check_tool_with_default(tool_name, args, &facts, tool_default)
    }

    /// Check permission for a tool call using facts collected before locking.
    ///
    /// One authoritative decision order:
    /// 1. Mode prohibition (Plan rejects mutating tools).
    /// 2. Explicit deny rules; nothing below can override them.
    /// 3. Fine-grained config policy for this tool and its arguments.
    /// 4. Remaining rules, first match wins.
    /// 5. The tool's own default (MCP hints), else the mode default.
    ///
    /// Automatic approval only upgrades a final `Ask` to `Allow`; it can never
    /// turn a `Deny` (mode prohibition or explicit rule) into an allow.
    pub fn check_tool_with_default(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        facts: &ToolFsFacts,
        tool_default: Option<Permission>,
    ) -> Permission {
        if self.mode == AgentMode::Plan
            && crate::tools::known_kind(tool_name).is_some_and(|kind| kind.mutates_project())
        {
            return Permission::Deny;
        }

        let action = format!("tool:{tool_name}");
        for rule in &self.rules {
            if rule.matches(&action) && rule.permission == Permission::Deny {
                return Permission::Deny;
            }
        }

        let decision = if self.mode == AgentMode::Build {
            self.check_config_rule(tool_name, args, facts)
        } else {
            None
        }
        .or_else(|| {
            self.rules
                .iter()
                .find(|rule| rule.matches(&action))
                .map(|rule| rule.permission)
        })
        .or(tool_default)
        .unwrap_or(match self.mode {
            AgentMode::Plan => Permission::Deny,
            AgentMode::Build => Permission::Allow,
        });

        // Auto-approve never waves through a destructive shell command: it
        // still asks, whatever the mode.
        let confirm_destructive = self
            .auto_approve_config
            .as_ref()
            .is_none_or(|config| config.confirm_destructive);
        let destructive = confirm_destructive
            && tool_name == "shell"
            && args
                .get("command")
                .and_then(serde_json::Value::as_str)
                .is_some_and(is_destructive_command);
        if destructive && decision == Permission::Allow {
            Permission::Ask
        } else if decision == Permission::Ask && self.auto_approve_all && !destructive {
            Permission::Allow
        } else {
            decision
        }
    }
}

impl Default for PermissionEngine {
    fn default() -> Self {
        Self::new(AgentMode::Plan)
    }
}

/// Extract the normalized basename of a command token (strip surrounding quotes,
/// leading alias-escape `\`, directory prefixes like `/bin/` or `C:\...\`, and
/// Windows `.exe`/`.com` suffixes).
fn command_basename(word: &str) -> &str {
    let trimmed = word.trim_matches(['\'', '"']).trim_start_matches('\\');
    let base = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    base.strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".com"))
        .unwrap_or(base)
}

fn is_env_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && !name.starts_with('-')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Strip leading environment assignments and common privilege/wrapper commands
/// (`sudo`, `env`, `doas`, `command`, `exec`, `nohup`, `time`, `nice`, `timeout`)
/// from a lowercased segment's words, returning `(command_basename, remaining_args)`.
fn unwrap_command<'a>(words: &'a [&'a str]) -> Option<(&'a str, &'a [&'a str])> {
    let mut i = 0;
    while i < words.len() {
        let word = words[i];
        if is_env_assignment(word) {
            i += 1;
            continue;
        }
        let base = command_basename(word);
        match base {
            "sudo" => {
                i += 1;
                while i < words.len() {
                    let flag = words[i];
                    if flag == "--" {
                        i += 1;
                        break;
                    }
                    if matches!(
                        flag,
                        "-u" | "-g"
                            | "-c"
                            | "-d"
                            | "-h"
                            | "-p"
                            | "-r"
                            | "-t"
                            | "--user"
                            | "--group"
                            | "--chdir"
                            | "--host"
                            | "--prompt"
                    ) {
                        i += 2;
                        continue;
                    }
                    if flag.starts_with('-') {
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            "doas" => {
                i += 1;
                while i < words.len() {
                    let flag = words[i];
                    if flag == "--" {
                        i += 1;
                        break;
                    }
                    if matches!(flag, "-u" | "-c") {
                        i += 2;
                        continue;
                    }
                    if flag.starts_with('-') {
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            "env" => {
                i += 1;
                while i < words.len() {
                    let flag = words[i];
                    if flag == "--" {
                        i += 1;
                        break;
                    }
                    if matches!(flag, "-u" | "-c" | "-s" | "--unset" | "--chdir") {
                        i += 2;
                        continue;
                    }
                    if flag.starts_with('-') || is_env_assignment(flag) {
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            "command" | "exec" | "nohup" | "time" => {
                i += 1;
                while i < words.len() {
                    let flag = words[i];
                    if flag == "--" {
                        i += 1;
                        break;
                    }
                    if flag.starts_with('-') {
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            "nice" => {
                i += 1;
                while i < words.len() {
                    let flag = words[i];
                    if flag == "--" {
                        i += 1;
                        break;
                    }
                    if matches!(flag, "-n" | "--adjustment") {
                        i += 2;
                        continue;
                    }
                    if flag.starts_with('-') {
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            "timeout" => {
                i += 1;
                while i < words.len() {
                    let flag = words[i];
                    if flag == "--" {
                        i += 1;
                        break;
                    }
                    if matches!(flag, "-k" | "-s" | "--kill-after" | "--signal") {
                        i += 2;
                        continue;
                    }
                    if flag.starts_with('-') {
                        i += 1;
                        continue;
                    }
                    // Skip the duration positional argument.
                    i += 1;
                    break;
                }
            }
            _ => return Some((base, &words[i + 1..])),
        }
    }
    None
}

/// Skip git global options (`-C repo`, `-c key=val`, `--git-dir path`, etc.) to
/// locate the subcommand and its arguments. Input words are lowercased.
fn git_subcommand_and_args<'a>(args: &'a [&'a str]) -> Option<(&'a str, &'a [&'a str])> {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i];
        if arg == "--" {
            return None;
        }
        if matches!(
            arg,
            "-c" | "--git-dir" | "--work-tree" | "--namespace" | "--config-env" | "--super-prefix"
        ) {
            i += 2;
            continue;
        }
        if arg.starts_with('-') {
            i += 1;
            continue;
        }
        return Some((arg, &args[i + 1..]));
    }
    None
}

/// Check if a shell command is dangerous (destructive, network exfiltration, etc.).
/// Used both to decide `Permission::Ask` in the permission engine and to set the
/// `is_dangerous` flag on approval requests.
pub fn is_dangerous_command(cmd: &str) -> bool {
    if is_destructive_command(cmd) {
        return true;
    }

    // Commands with pipes or redirects that could be dangerous
    if cmd.contains('|') || cmd.contains('>') {
        // Could be data exfiltration
        return true;
    }

    let cmd_lower = cmd.to_lowercase();
    for segment in cmd_lower.split([';', '|', '&', '\n', '\r', '(', ')', '`']) {
        let words: Vec<&str> = segment.split_whitespace().collect();
        let Some((name, args)) = unwrap_command(&words) else {
            continue;
        };
        let dangerous = matches!(
            name,
            "rm" | "mkfs"
                | "format"
                | "fdisk"
                | "shutdown"
                | "reboot"
                | "poweroff"
                | "halt"
                | "curl"
                | "wget"
                | "nc"
                | "netcat"
                | "ncat"
        ) || name.starts_with("mkfs.")
            || (name == "dd"
                && args
                    .iter()
                    .any(|arg| arg.starts_with("if=") || arg.starts_with("of=")));
        if dangerous {
            return true;
        }
    }

    false
}

/// Commands that destroy data or history and are hard or impossible to undo:
/// recursive `rm`, `mkfs`, `git push --force` (not `--force-with-lease`),
/// `DROP TABLE` / `DROP DATABASE`, and the classic fork bomb. These always
/// need a person's yes, even in auto mode.
pub fn is_destructive_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains(":(){:|:&};:")
        || lower.contains("drop table")
        || lower.contains("drop database")
    {
        return true;
    }

    for segment in lower.split([';', '|', '&', '\n', '\r', '(', ')', '`']) {
        let words: Vec<&str> = segment.split_whitespace().collect();
        let Some((name, args)) = unwrap_command(&words) else {
            continue;
        };

        if name == "rm" {
            let recursive = args.iter().take_while(|&&arg| arg != "--").any(|arg| {
                *arg == "--recursive"
                    || (arg.starts_with('-') && !arg.starts_with("--") && arg[1..].contains('r'))
            });
            if recursive {
                return true;
            }
        }

        if name == "git" {
            if let Some(("push", push_args)) = git_subcommand_and_args(args) {
                let forced = push_args.iter().take_while(|&&arg| arg != "--").any(|arg| {
                    *arg == "--force"
                        || (arg.starts_with('-')
                            && !arg.starts_with("--")
                            && arg[1..].contains('f'))
                });
                if forced {
                    return true;
                }
            }
        }

        if name == "mkfs" || name.starts_with("mkfs.") {
            return true;
        }
    }

    false
}

/// Project files that decide what code runs later; edits to them always ask.
fn is_protected_path(path: &str) -> bool {
    path.replace('\\', "/").split('/').any(|part| {
        let lower = part.to_ascii_lowercase();
        matches!(
            lower.as_str(),
            ".git" | ".agente" | ".claude" | ".agents" | ".mcp.json" | "agente.json" | ".envrc"
        ) || lower.starts_with(".env")
    })
}

/// Prefix of an approval description when a shell call may act outside the
/// project; the UIs show it as the reason for asking.
pub const OUTSIDE_PROJECT_PREFIX: &str = "Runs outside the project: ";

/// Paths (or constructs) in a shell command that leave `project_dir` or cannot
/// be decided statically: absolute paths outside the root, `..` past it, `~`,
/// `$VARS`, command substitution, bare `cd`/`pushd`, and redirect targets.
/// Empty means every path in the command stays inside the project. Purely
/// lexical (no I/O, symlinks are not followed), and conservative: a word that
/// might be a path outside is reported. `/dev/null` is always fine.
pub fn shell_outside_paths(cmd: &str, project_dir: Option<&std::path::Path>) -> Vec<String> {
    const MAX_REPORTED: usize = 4;
    let mut found: Vec<String> = Vec::new();
    let mut report = |what: &str| {
        if found.len() < MAX_REPORTED && !found.iter().any(|seen| seen == what) {
            found.push(what.to_string());
        }
    };
    if cmd.contains('`') || cmd.contains("$(") {
        report("command substitution");
    }
    let root = project_dir.map(lexical_normalize);
    for segment in cmd.split([';', '|', '&', '\n', '\r', '(', ')']) {
        let words: Vec<&str> = segment.split_whitespace().collect();
        if words.len() == 1 && matches!(words[0], "cd" | "pushd") {
            report("~");
        }
        for word in words {
            let clean = word.replace(['\'', '"'], "");
            // `$(` is reported above; a lone trailing `$` is not a variable.
            if clean.trim_end_matches('$').contains('$') {
                report(&clean);
                continue;
            }
            // `2>file`, `>>file`, `<file`: the target is what matters.
            let after_fd = clean.trim_start_matches(|c: char| c.is_ascii_digit() || c == '&');
            let target = if after_fd.starts_with(['<', '>']) {
                after_fd.trim_start_matches(['<', '>'])
            } else {
                clean.as_str()
            };
            for piece in target.split(['=', ',', '{', '}']) {
                // `-I/usr/include`, `-C/path`: a short flag glued to its value.
                let piece = match piece.char_indices().nth(2) {
                    Some((value_at, _)) if piece.starts_with('-') && !piece.starts_with("--") => {
                        &piece[value_at..]
                    }
                    _ => piece,
                };
                if piece_leaves_project(piece, root.as_deref()) {
                    report(piece);
                }
            }
        }
    }
    found
}

fn piece_leaves_project(piece: &str, root: Option<&std::path::Path>) -> bool {
    if piece.starts_with('~') {
        return true;
    }
    let bytes = piece.as_bytes();
    let absolute = piece.starts_with('/')
        || piece.starts_with('\\')
        || std::path::Path::new(piece).is_absolute()
        || (bytes.len() > 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'));
    if absolute {
        if piece == "/dev/null" {
            return false;
        }
        return !root
            .is_some_and(|root| lexical_normalize(std::path::Path::new(piece)).starts_with(root));
    }
    // Relative: only a `..` that climbs past the project root escapes.
    let mut depth = 0usize;
    for part in piece.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." if depth == 0 => return true,
            ".." => depth -= 1,
            _ => depth += 1,
        }
    }
    false
}

/// Resolve `.` and `..` without touching the filesystem.
fn lexical_normalize(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// True when a command chains or substitutes other commands. Safe-command
/// auto-approval only covers a single simple command: `cargo check && curl x`
/// must not inherit the `cargo check` allowance.
fn shell_composes(cmd: &str) -> bool {
    // A lone `&` backgrounds the first command and starts another; `<(`/`>(`
    // substitute processes; `\r` can hide a second line from the prompt.
    const TOKENS: [&str; 10] = ["&", "||", ";", "|", "`", "$(", "<(", ">(", "\n", "\r"];
    TOKENS.iter().any(|token| cmd.contains(token))
}

/// Thread-safe permission engine handle
pub type SharedPermissionEngine = Arc<RwLock<PermissionEngine>>;

/// Create a shared permission engine
pub fn shared_permission_engine(mode: AgentMode) -> SharedPermissionEngine {
    Arc::new(RwLock::new(PermissionEngine::new(mode)))
}

/// Create a shared permission engine seeded with config-driven rules.
pub fn shared_permission_engine_with_config(
    mode: AgentMode,
    config: &AutoApproveConfig,
    project_dir: &str,
) -> SharedPermissionEngine {
    Arc::new(RwLock::new(
        PermissionEngine::from_config(mode, config).with_project_dir(project_dir),
    ))
}

/// Routes tool-approval requests from any number of concurrent agents (the
/// parent and its subagents) to the UI and back, keyed by request id.
///
/// Replaces the old single `mpsc` approval channel: a shared channel could not
/// be used by more than one waiting task, and replies from concurrent agents
/// could cross. Each waiting agent calls [`ApprovalBroker::request`] and awaits
/// the returned oneshot; the UI calls [`ApprovalBroker::respond`] with the
/// `request_id` it saw in `AgentEvent::ApprovalRequested`.
#[derive(Clone)]
pub struct ApprovalBroker {
    inner: Arc<ApprovalBrokerInner>,
}

struct ApprovalBrokerInner {
    pending: std::sync::Mutex<
        std::collections::HashMap<String, tokio::sync::oneshot::Sender<ApprovalAction>>,
    >,
    /// Bumped whenever a request is registered or resolved (UI wakeups).
    notify: tokio::sync::watch::Sender<u64>,
}

impl Default for ApprovalBrokerInner {
    fn default() -> Self {
        let (notify, _rx) = tokio::sync::watch::channel(0u64);
        Self {
            pending: std::sync::Mutex::new(std::collections::HashMap::new()),
            notify,
        }
    }
}

impl Default for ApprovalBroker {
    fn default() -> Self {
        Self::new()
    }
}

impl ApprovalBroker {
    /// Create a new empty broker.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ApprovalBrokerInner::default()),
        }
    }

    /// Register a pending approval request and return the receiver the waiting
    /// agent awaits. The request must already carry a unique `request_id`.
    pub fn request(
        &self,
        request: &ApprovalRequest,
    ) -> tokio::sync::oneshot::Receiver<ApprovalAction> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(request.request_id.clone(), tx);
        let _ = self
            .inner
            .notify
            .send(self.inner.notify.borrow().wrapping_add(1));
        rx
    }

    /// Resolve a pending approval with the user's action. Returns `false` when
    /// the request id is unknown (already answered or cancelled).
    pub fn respond(&self, request_id: &str, action: ApprovalAction) -> bool {
        let tx = self
            .inner
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(request_id);
        let sent = match tx {
            Some(tx) => tx.send(action).is_ok(),
            None => false,
        };
        if sent {
            let _ = self
                .inner
                .notify
                .send(self.inner.notify.borrow().wrapping_add(1));
        }
        sent
    }

    /// Drop a pending approval without answering it (the waiting agent was
    /// cancelled). No-op if it was already resolved.
    pub fn cancel(&self, request_id: &str) {
        if self
            .inner
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(request_id)
            .is_some()
        {
            let _ = self
                .inner
                .notify
                .send(self.inner.notify.borrow().wrapping_add(1));
        }
    }

    /// Cancel and drop all pending approvals without answering them.
    pub fn cancel_all(&self) {
        let mut pending = self
            .inner
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !pending.is_empty() {
            pending.clear();
            let _ = self
                .inner
                .notify
                .send(self.inner.notify.borrow().wrapping_add(1));
        }
    }

    /// Number of approvals waiting for a user response.
    pub fn pending_count(&self) -> usize {
        self.inner
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// A watcher that fires whenever a request is registered or resolved.
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.inner.notify.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rule_matching() {
        let rule = PermissionRule::new("tool:read", Permission::Allow);
        assert!(rule.matches("tool:read"));
        assert!(!rule.matches("tool:write"));
    }

    #[test]
    fn test_wildcard_matching() {
        let rule = PermissionRule::new("tool:*", Permission::Allow);
        assert!(rule.matches("tool:read"));
        assert!(rule.matches("tool:write"));
        assert!(!rule.matches("file:read"));

        // `**` crosses `/` boundaries; `**/` matches zero or more directories.
        let toml_any = PermissionRule::new("file:**/*.toml", Permission::Allow);
        assert!(toml_any.matches("file:Cargo.toml"));
        assert!(toml_any.matches("file:crates/core/Cargo.toml"));
        assert!(toml_any.matches("file:a/b/c/config.toml"));
        assert!(!toml_any.matches("file:crates/core/Cargo.toml.bak"));
        assert!(!toml_any.matches("file:crates/core/Cargo.json"));

        // Single `*` does not cross `/` boundaries.
        let toml_root = PermissionRule::new("file:*.toml", Permission::Allow);
        assert!(toml_root.matches("file:Cargo.toml"));
        assert!(!toml_root.matches("file:crates/Cargo.toml"));

        // Start and end anchors are enforced when no leading/trailing `*`.
        let anchored = PermissionRule::new("a*b", Permission::Allow);
        assert!(anchored.matches("ab"));
        assert!(anchored.matches("axb"));
        assert!(!anchored.matches("axbyyy"));
        assert!(!anchored.matches("xxxab"));

        // Multi-`*` advances cursor correctly without rewinding to relative offsets.
        let multi = PermissionRule::new("a*b*c", Permission::Allow);
        assert!(multi.matches("a123b456c"));
        assert!(multi.matches("a123b456b789c"));
        assert!(!multi.matches("a123c456b"));
        assert!(!multi.matches("a123b456c789"));
    }

    #[test]
    fn test_plan_mode_defaults() {
        let engine = PermissionEngine::new(AgentMode::Plan);
        let no_args = serde_json::json!({});

        // Read operations should be allowed
        assert_eq!(engine.check_tool("read_file", &no_args), Permission::Allow);

        // Write operations are denied in Plan mode
        assert_eq!(engine.check_tool("write_file", &no_args), Permission::Deny);
        assert_eq!(engine.check_tool("edit_file", &no_args), Permission::Deny);
    }

    /// Plan mode is where exploration happens, so the hosted subagent family
    /// must pass the engine (the host still coerces children to read-only).
    /// Before this rule existed every `task` call was denied while the tool was
    /// advertised as allowed, which is why `explore` never ran.
    #[test]
    fn plan_mode_allows_subagent_orchestration() {
        let engine = PermissionEngine::new(AgentMode::Plan);
        for tool in ["task", "task_output", "kill_task"] {
            assert_eq!(
                engine.check_tool(tool, &serde_json::json!({})),
                Permission::Allow,
                "{tool} must be usable in Plan mode"
            );
        }
        // The read-only guarantees still hold.
        assert_eq!(
            engine.check_tool("write_file", &serde_json::json!({})),
            Permission::Deny
        );
        assert_eq!(
            engine.check_tool("shell", &serde_json::json!({"command": "ls"})),
            Permission::Deny
        );
    }

    #[test]
    fn test_build_mode_defaults() {
        let engine = PermissionEngine::new(AgentMode::Build);
        let no_args = serde_json::json!({});

        // Most operations allowed
        assert_eq!(engine.check_tool("write_file", &no_args), Permission::Allow);
        assert_eq!(engine.check_tool("edit_file", &no_args), Permission::Allow);
        // Every shell call in Build mode asks for approval.
        assert_eq!(engine.check_tool("shell", &no_args), Permission::Ask);
    }

    #[test]
    fn test_build_mode_shell_requires_approval() {
        let engine = PermissionEngine::new(AgentMode::Build);
        // Even a benign shell command must ask in Build mode.
        let args = serde_json::json!({ "command": "cargo build" });
        assert_eq!(engine.check_tool("shell", &args), Permission::Ask);
    }

    #[test]
    fn test_build_mode_shell_auto_approve_bypasses_ask() {
        let mut engine = PermissionEngine::new(AgentMode::Build);
        let args = serde_json::json!({ "command": "ls" });
        assert_eq!(engine.check_tool("shell", &args), Permission::Ask);
        engine.set_auto_approve(true);
        assert_eq!(engine.check_tool("shell", &args), Permission::Allow);
    }

    #[test]
    fn test_plan_mode_shell_denied() {
        let engine = PermissionEngine::new(AgentMode::Plan);
        let args = serde_json::json!({ "command": "ls" });
        assert_eq!(engine.check_tool("shell", &args), Permission::Deny);
    }

    #[test]
    fn test_auto_approve() {
        let mut engine = PermissionEngine::new(AgentMode::Plan);

        // Without auto-approve, Plan mode denies writes
        assert_eq!(
            engine.check_tool("write_file", &serde_json::json!({})),
            Permission::Deny
        );

        // With auto-approve, explicit denies still win.
        engine.set_auto_approve(true);
        assert_eq!(
            engine.check_tool("write_file", &serde_json::json!({})),
            Permission::Deny
        );
    }

    #[test]
    fn test_build_mode_dangerous_shell_asks_unless_auto_approved() {
        let mut engine = PermissionEngine::new(AgentMode::Build);
        let args = serde_json::json!({ "command": "rm -rf target/tmp" });

        assert_eq!(engine.check_tool("shell", &args), Permission::Ask);

        // Auto mode still asks before a destructive command…
        engine.set_auto_approve(true);
        assert_eq!(engine.check_tool("shell", &args), Permission::Ask);

        // …unless the user turned that off.
        let config = AutoApproveConfig {
            confirm_destructive: false,
            ..AutoApproveConfig::default()
        };
        let mut engine = PermissionEngine::from_config(AgentMode::Build, &config);
        engine.set_auto_approve(true);
        assert_eq!(engine.check_tool("shell", &args), Permission::Allow);
    }

    #[test]
    fn test_set_mode_resets_default_rules() {
        let mut engine = PermissionEngine::new(AgentMode::Plan);
        assert_eq!(
            engine.check_tool("write_file", &serde_json::json!({})),
            Permission::Deny
        );

        engine.set_mode(AgentMode::Build);
        assert_eq!(
            engine.check_tool("write_file", &serde_json::json!({})),
            Permission::Allow
        );
    }

    #[test]
    fn build_mode_respects_config_rules() {
        let mut config = crate::config::AutoApproveConfig::default();
        config.safe_commands.push("cargo check".to_string());
        let engine = PermissionEngine::from_config(AgentMode::Build, &config);

        assert_eq!(
            engine.check_tool("shell", &serde_json::json!({ "command": "cargo check" })),
            Permission::Allow
        );
        assert_eq!(
            engine.check_tool("shell", &serde_json::json!({ "command": "curl http://x" })),
            Permission::Ask
        );
        assert_eq!(
            engine.check_tool("write_file", &serde_json::json!({ "path": "new.txt" })),
            Permission::Ask
        );
    }

    /// An explicit deny is a safety boundary: auto-approve and a matching
    /// config allow must not override it.
    #[test]
    fn explicit_deny_beats_auto_approve_and_config_allow() {
        let config = crate::config::AutoApproveConfig {
            write_new_files: true,
            ..Default::default()
        };
        let mut engine = PermissionEngine::from_config(AgentMode::Build, &config);
        engine.add_rule(PermissionRule::new("tool:write_file", Permission::Deny));
        engine.set_auto_approve(true);

        assert_eq!(
            engine.check_tool(
                "write_file",
                &serde_json::json!({ "path": "new.txt", "content": "x" })
            ),
            Permission::Deny
        );

        let mut shell_config = crate::config::AutoApproveConfig::default();
        shell_config.safe_commands.push("cargo check".to_string());
        let mut shell_engine = PermissionEngine::from_config(AgentMode::Build, &shell_config);
        shell_engine.add_rule(PermissionRule::new("tool:shell", Permission::Deny));
        shell_engine.set_auto_approve(true);
        assert_eq!(
            shell_engine.check_tool("shell", &serde_json::json!({ "command": "cargo check" })),
            Permission::Deny
        );
    }

    /// `apply_patch` targets come from patch headers, so the fine-grained
    /// config cannot inspect them: it must ask, not inherit the mode allow.
    #[test]
    fn apply_patch_asks_under_fine_grained_config() {
        let config = crate::config::AutoApproveConfig::default();
        let mut engine = PermissionEngine::from_config(AgentMode::Build, &config);
        let args = serde_json::json!({ "patch": "--- a/x\n+++ b/x\n" });
        assert_eq!(engine.check_tool("apply_patch", &args), Permission::Ask);
        engine.set_auto_approve(true);
        assert_eq!(engine.check_tool("apply_patch", &args), Permission::Allow);
    }

    #[test]
    fn plan_mode_denies_apply_patch() {
        let engine = PermissionEngine::new(AgentMode::Plan);
        assert_eq!(
            engine.check_tool("apply_patch", &serde_json::json!({ "patch": "x" })),
            Permission::Deny
        );
    }

    /// Safe-command auto-approval covers one simple command, not a chain that
    /// happens to start with the safe prefix.
    #[test]
    fn safe_command_allowance_does_not_extend_to_chains() {
        let mut config = crate::config::AutoApproveConfig::default();
        config.safe_commands.push("cargo check".to_string());
        let engine = PermissionEngine::from_config(AgentMode::Build, &config);

        assert_eq!(
            engine.check_tool(
                "shell",
                &serde_json::json!({ "command": "cargo check --all-targets" })
            ),
            Permission::Allow
        );
        assert_eq!(
            engine.check_tool(
                "shell",
                &serde_json::json!({ "command": "cargo check && echo hi" })
            ),
            Permission::Ask
        );
        assert_eq!(
            engine.check_tool(
                "shell",
                &serde_json::json!({ "command": "cargo check; echo hi" })
            ),
            Permission::Ask
        );
    }

    #[test]
    fn config_edits_of_protected_files_always_ask() {
        let engine = PermissionEngine::from_config(AgentMode::Build, &AutoApproveConfig::default());
        let tiny = serde_json::json!({"path": ".mcp.json", "search": "a", "replace": "b"});
        assert_eq!(
            engine.check_tool_with_default(
                "edit_file",
                &tiny,
                &ToolFsFacts {
                    target_exists: true,
                    target_line_count: Some(3)
                },
                None
            ),
            Permission::Ask
        );
        let plain = serde_json::json!({"path": "src/a.rs", "search": "a", "replace": "b"});
        assert_eq!(
            engine.check_tool_with_default(
                "edit_file",
                &plain,
                &ToolFsFacts {
                    target_exists: true,
                    target_line_count: Some(3)
                },
                None
            ),
            Permission::Allow
        );
    }

    #[test]
    fn background_ampersand_is_not_a_safe_command() {
        let engine = PermissionEngine::from_config(AgentMode::Build, &AutoApproveConfig::default());
        let args = serde_json::json!({"command": "git status & ./evil.sh"});
        assert_eq!(engine.check_tool("shell", &args), Permission::Ask);
    }

    #[test]
    fn approval_broker_routes_responses_by_id() {
        let broker = ApprovalBroker::new();
        let mut req1 = ApprovalRequest {
            request_id: "r1".to_string(),
            tool_name: "shell".to_string(),
            tool_args: "{}".to_string(),
            description: "cmd".to_string(),
            is_dangerous: false,
            old_content: None,
            new_content: None,
            file_path: None,
        };
        let mut req2 = ApprovalRequest {
            request_id: "r2".to_string(),
            ..req1.clone()
        };
        req1.request_id = "r1".to_string();
        req2.request_id = "r2".to_string();

        assert_eq!(broker.pending_count(), 0);
        let rx1 = broker.request(&req1);
        let rx2 = broker.request(&req2);
        assert_eq!(broker.pending_count(), 2);

        // Resolve r2 first; r1 must still be pending and get its own reply.
        assert!(broker.respond("r2", ApprovalAction::Deny));
        assert!(!broker.respond("r2", ApprovalAction::ApproveOnce)); // already resolved
        assert_eq!(broker.pending_count(), 1);

        let rt = tokio::runtime::Runtime::new().unwrap();
        let got2 = rt.block_on(async { rx2.await.ok() });
        assert_eq!(got2, Some(ApprovalAction::Deny));

        assert!(broker.respond("r1", ApprovalAction::ApproveOnce));
        let got1 = rt.block_on(async { rx1.await.ok() });
        assert_eq!(got1, Some(ApprovalAction::ApproveOnce));
        assert_eq!(broker.pending_count(), 0);

        // Cancelling an unanswered request drops it without a reply.
        let mut req3 = req1.clone();
        req3.request_id = "r3".to_string();
        let rx3 = broker.request(&req3);
        broker.cancel("r3");
        assert_eq!(broker.pending_count(), 0);
        let got3 = rt.block_on(async { rx3.await.ok() });
        assert_eq!(got3, None);
    }

    #[test]
    fn destructive_commands_always_ask_even_in_auto_mode() {
        for command in [
            "rm -rf build",
            "rm -fr /tmp/x",
            "cd x && rm -r dir",
            "git push origin main --force",
            "git push -f",
            "mkfs.ext4 /dev/sdb1",
            "psql -c 'DROP TABLE users'",
            ":(){ :|:& };:",
        ] {
            assert!(is_destructive_command(command), "{command}");
        }
        for command in [
            "git push --force-with-lease",
            "rm file.txt",
            "cargo test",
            "grep -r TODO src",
            "git status",
        ] {
            assert!(!is_destructive_command(command), "{command}");
        }

        let mut engine = PermissionEngine::new(AgentMode::Build);
        engine.set_auto_approve(true);
        let args = |command: &str| serde_json::json!({ "command": command });
        assert_eq!(
            engine.check_tool("shell", &args("rm -rf build")),
            Permission::Ask
        );
        assert_eq!(
            engine.check_tool("shell", &args("git push --force")),
            Permission::Ask
        );
        assert_eq!(engine.check_tool("shell", &args("ls")), Permission::Allow);
    }

    fn build_engine_at(root: &str) -> PermissionEngine {
        let mut config = crate::config::AutoApproveConfig::default();
        config.safe_commands.push("cat".to_string());
        PermissionEngine::from_config(AgentMode::Build, &config).with_project_dir(root)
    }

    /// A safe-listed command stays unasked only while its paths stay inside
    /// the project; anything outside, or undecidable, asks.
    #[test]
    fn safe_commands_reaching_outside_the_project_ask() {
        let engine = build_engine_at("/work/proj");
        let decide =
            |command: &str| engine.check_tool("shell", &serde_json::json!({ "command": command }));
        for command in [
            "ls",
            "ls src",
            "ls ./src/../tests",
            "ls /work/proj/src",
            "git status",
            "git diff -- src/lib.rs",
            "cat README.md",
            "cargo test -- --nocapture",
        ] {
            assert_eq!(decide(command), Permission::Allow, "{command}");
        }
        for command in [
            "ls /etc",
            "ls -la /",
            "ls ..",
            "ls ../other",
            "ls src/../../x",
            "cat ~/.ssh/id_rsa",
            "ls ~",
            "ls $HOME",
            "ls \"$HOME/x\"",
            "ls ${TMPDIR}",
            "cat /etc/passwd",
            "ls /work/proj/../other",
            "ls /work/project2",
            "git diff --output=/tmp/x",
            "git -C /elsewhere status",
            "cargo test --manifest-path=/x/Cargo.toml",
            "ls -I/usr",
            "cat 'a b' /etc/hosts",
            "cat x > /tmp/x",
            "cat x >> ~/.bashrc",
            "cat x 2>/tmp/err",
            "cat </etc/passwd",
            "cd /elsewhere",
            "cd",
            "ls \\windows",
        ] {
            assert_eq!(decide(command), Permission::Ask, "{command}");
        }
    }

    #[test]
    fn outside_paths_name_what_is_outside() {
        let root = std::path::Path::new("/work/proj");
        assert_eq!(
            shell_outside_paths("ls /etc ../x src", Some(root)),
            vec!["/etc".to_string(), "../x".to_string()]
        );
        assert_eq!(
            shell_outside_paths("echo $(whoami)", Some(root)),
            vec!["command substitution".to_string()]
        );
        assert_eq!(
            shell_outside_paths("pushd", Some(root)),
            vec!["~".to_string()]
        );
        assert!(shell_outside_paths("cargo test 2>/dev/null", Some(root)).is_empty());
        assert!(shell_outside_paths("ls /work/proj/a", Some(root)).is_empty());
        // Unknown root: absolute paths cannot be shown to be inside.
        assert_eq!(shell_outside_paths("ls /work/proj/a", None).len(), 1);
        assert!(shell_outside_paths("ls src", None).is_empty());
    }

    /// Auto mode still approves an outside-project call (the user chose to
    /// skip prompts); Plan mode still denies shell outright.
    #[test]
    fn outside_project_shell_keeps_auto_and_plan_behaviour() {
        let args = serde_json::json!({ "command": "ls /etc" });
        let mut engine = build_engine_at("/work/proj");
        assert_eq!(engine.check_tool("shell", &args), Permission::Ask);
        engine.set_auto_approve(true);
        assert_eq!(engine.check_tool("shell", &args), Permission::Allow);

        let plan = PermissionEngine::new(AgentMode::Plan).with_project_dir("/work/proj");
        assert_eq!(plan.check_tool("shell", &args), Permission::Deny);
    }

    #[test]
    fn destructive_commands_handle_paths_sudo_and_git_global_flags() {
        for command in [
            "/bin/rm -rf build",
            "/usr/bin/rm -r dir",
            "\\rm -rf dir",
            "sudo rm -rf /tmp/x",
            "sudo -u root /bin/rm -rf /tmp/x",
            "FOO=1 env BAR=2 sudo -E /bin/rm --recursive dir",
            "git -C repo push --force",
            "git -C repo push -f origin main",
            "/usr/bin/git --git-dir /repo --no-pager push --force",
            "sudo git -c http.sslVerify=false push --force",
            "sudo /sbin/mkfs.ext4 /dev/sdb1",
        ] {
            assert!(
                is_destructive_command(command),
                "should be destructive: {command}"
            );
        }
        for command in [
            "git -C repo push --force-with-lease",
            "git -C repo status",
            "sudo rm file.txt",
            "/bin/rm file.txt",
            "rm -- -rf",
        ] {
            assert!(
                !is_destructive_command(command),
                "should not be destructive: {command}"
            );
        }
    }

    #[test]
    fn dangerous_commands_respect_token_boundaries() {
        // Benign commands that previously false-positived on substring matches.
        for command in [
            "git log --format=%H",
            "git log --pretty=format:%s",
            "rsync -av src/ dst/",
            "echo confirm please",
            "cargo test curl_parser",
            "git commit -m 'reformat code'",
        ] {
            assert!(!is_dangerous_command(command), "false positive: {command}");
        }
        // Genuine dangerous commands (including via path prefix / sudo / subshell).
        for command in [
            "rm file.txt",
            "/bin/rm file.txt",
            "sudo rm -rf /tmp/x",
            "git -C repo push --force",
            "format c:",
            "dd if=/dev/zero of=/dev/sda",
            "nc -lvp 4444",
            "/usr/bin/netcat example.com 80",
            "sudo curl https://example.com",
            "echo $(curl https://example.com)",
            "cat file | sh",
            "echo hi > out.txt",
        ] {
            assert!(
                is_dangerous_command(command),
                "should be dangerous: {command}"
            );
        }
    }

    #[test]
    fn protected_paths_are_case_insensitive() {
        let config = AutoApproveConfig {
            write_new_files: true,
            max_auto_edit_lines: 500,
            ..Default::default()
        };
        let engine = PermissionEngine::from_config(AgentMode::Build, &config);
        for path in [
            ".MCP.JSON",
            ".ENV",
            ".ENV.local",
            ".GIT/hooks/pre-commit",
            ".AGENTE/config.json",
            "AGENTE.JSON",
        ] {
            let edit_args = serde_json::json!({ "path": path, "search": "a", "replace": "b" });
            assert_eq!(
                engine.check_tool_with_default(
                    "edit_file",
                    &edit_args,
                    &ToolFsFacts {
                        target_exists: true,
                        target_line_count: Some(3),
                    },
                    None,
                ),
                Permission::Ask,
                "edit_file on {path} must ask"
            );
            let write_args = serde_json::json!({ "path": path, "content": "x" });
            assert_eq!(
                engine.check_tool_with_default(
                    "write_file",
                    &write_args,
                    &ToolFsFacts {
                        target_exists: false,
                        target_line_count: None,
                    },
                    None,
                ),
                Permission::Ask,
                "write_file on {path} must ask"
            );
        }
    }

    #[test]
    fn plan_mode_allows_orchestrator_tools() {
        let engine = PermissionEngine::new(AgentMode::Plan);
        for tool in [
            "orchestrator_list_drivers",
            "orchestrator_spawn_task",
            "orchestrator_get_task",
            "orchestrator_list_tasks",
            "orchestrator_cancel_task",
            "orchestrator_steer_task",
            "orchestrator_board_get",
            "orchestrator_board_post",
        ] {
            assert_eq!(
                engine.check_tool(tool, &serde_json::json!({})),
                Permission::Allow,
                "{tool} must be allowed in Plan mode"
            );
        }
    }
}
