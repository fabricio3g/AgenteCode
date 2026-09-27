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

impl Permission {
    /// Check if permission requires user interaction
    pub fn requires_prompt(&self) -> bool {
        matches!(self, Self::Ask)
    }

    /// Check if permission is granted
    pub fn is_allowed(&self) -> bool {
        !matches!(self, Self::Deny)
    }
}

/// Permission rule with pattern matching
#[derive(Debug, Clone)]
pub struct PermissionRule {
    /// Pattern to match (e.g., "file:write", "tool:bash", "file:**/*.toml")
    pub pattern: String,
    /// Permission decision for matching actions
    pub permission: Permission,
    /// Optional description
    pub description: Option<String>,
}

impl PermissionRule {
    /// Create a new permission rule
    pub fn new(pattern: impl Into<String>, permission: Permission) -> Self {
        Self {
            pattern: pattern.into(),
            permission,
            description: None,
        }
    }

    /// Create a new permission rule with description
    pub fn with_description(
        pattern: impl Into<String>,
        permission: Permission,
        description: impl Into<String>,
    ) -> Self {
        Self {
            pattern: pattern.into(),
            permission,
            description: Some(description.into()),
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
            let pattern_parts: Vec<&str> = self.pattern.split('*').collect();
            return match_wildcard(action, &self.pattern, &pattern_parts);
        }

        // Prefix match (e.g., "tool:" matches all tools)
        if self.pattern.ends_with(':') {
            return action.starts_with(&self.pattern);
        }

        false
    }
}

fn match_wildcard(action: &str, pattern: &str, pattern_parts: &[&str]) -> bool {
    if pattern_parts.is_empty() {
        return true;
    }

    // Simple implementation: ** matches across / boundaries
    let double_star = "**";
    if pattern.contains(double_star) {
        // For now, treat ** the same as *
        let combined: String = pattern_parts.join("");
        return action.contains(&combined);
    }

    // Standard wildcard matching
    let mut pattern_idx = 0;
    let mut action_idx = 0;

    while pattern_idx < pattern_parts.len() && action_idx < action.len() {
        let part = pattern_parts[pattern_idx];

        if part.is_empty() {
            // ** pattern - matches anything including /
            pattern_idx += 1;
            if pattern_idx < pattern_parts.len() {
                let next_part = pattern_parts[pattern_idx];
                if let Some(pos) = action[action_idx..].find(next_part) {
                    action_idx = pos + next_part.len();
                } else {
                    return false;
                }
            }
            continue;
        }

        if let Some(pos) = action[action_idx..].find(part) {
            action_idx = pos + part.len();
            pattern_idx += 1;
        } else {
            return false;
        }
    }

    // Handle trailing wildcard
    if pattern_idx < pattern_parts.len() {
        let remaining = pattern_parts[pattern_idx..].join("");
        if remaining.is_empty() || remaining == "*" {
            return true;
        }
        return action[action_idx..].ends_with(&remaining);
    }

    true
}

/// Default permission rules for Plan mode
pub fn plan_mode_default_rules() -> Vec<PermissionRule> {
    vec![
        // Read operations are allowed
        PermissionRule::new("file:read", Permission::Allow),
        PermissionRule::new("tool:read_file", Permission::Allow),
        PermissionRule::new("tool:list_dir", Permission::Allow),
        PermissionRule::new("tool:grep", Permission::Allow),
        PermissionRule::new("tool:todo_write", Permission::Allow),
        // Loading a skill only reads its instructions.
        PermissionRule::new("tool:skill", Permission::Allow),
        // Subagent orchestration is safe in Plan mode: the host coerces every
        // child to read-only tools, so spawning research children is the
        // intended way to explore before presenting a plan.
        PermissionRule::new("tool:task", Permission::Allow),
        PermissionRule::new("tool:task_output", Permission::Allow),
        PermissionRule::new("tool:kill_task", Permission::Allow),
        // Present finished plan for Accept / Redo / Comment (writes only under .agente/plans/)
        PermissionRule::new("tool:present_plan", Permission::Allow),
        // Mutating operations are denied in Plan mode. Switch to Build mode to edit.
        PermissionRule::with_description("file:write", Permission::Deny, "Write to files"),
        PermissionRule::with_description("file:edit", Permission::Deny, "Edit existing files"),
        PermissionRule::with_description("tool:write_file", Permission::Deny, "Write files"),
        PermissionRule::with_description("tool:edit_file", Permission::Deny, "Edit files"),
        // Shell commands are denied in Plan mode.
        PermissionRule::with_description("tool:shell", Permission::Deny, "Execute commands"),
    ]
}

/// Default permission rules for Build mode
pub fn build_mode_default_rules() -> Vec<PermissionRule> {
    vec![
        // Most operations allowed
        PermissionRule::new("file:*", Permission::Allow),
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
        PermissionRule::with_description("tool:shell", Permission::Ask, "Run shell command"),
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

    /// Create a permission engine with custom rules
    pub fn with_rules(mode: AgentMode, rules: Vec<PermissionRule>) -> Self {
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

    /// Clear all rules
    pub fn clear_rules(&mut self) {
        self.rules.clear();
    }

    /// Check permission for an action
    ///
    /// Returns the permission decision. Rules are evaluated in order, first match wins.
    pub fn check(&self, action: &str) -> Permission {
        // Explicit denies are safety boundaries; auto-approve only bypasses prompts.
        for rule in &self.rules {
            if rule.matches(action) && rule.permission == Permission::Deny {
                return Permission::Deny;
            }
        }

        if self.auto_approve_all {
            return Permission::Allow;
        }

        for rule in &self.rules {
            if rule.matches(action) {
                return rule.permission;
            }
        }

        // Default: deny in plan mode, allow in build mode
        match self.mode {
            AgentMode::Plan => Permission::Deny,
            AgentMode::Build => Permission::Allow,
        }
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
    /// [`PermissionEngine::check_tool_with_facts`] on hot paths).
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
    pub fn check_tool_with_facts(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        facts: &ToolFsFacts,
    ) -> Permission {
        self.check_tool_with_default(tool_name, args, facts, None)
    }

    /// [`Self::check_tool_with_facts`] where the tool supplies its own
    /// fallback (step 5) instead of the mode default.
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

        if decision == Permission::Ask && self.auto_approve_all {
            Permission::Allow
        } else {
            decision
        }
    }

    /// Check permission for file operations
    pub fn check_file_op(&self, operation: &str, path: &str) -> Permission {
        if self.mode == AgentMode::Plan && matches!(operation, "write" | "edit" | "delete") {
            return Permission::Deny;
        }

        let action = format!("file:{operation}");

        // Check specific path patterns
        let path_action = format!("{action}:{path}");
        for rule in &self.rules {
            if rule.matches(&path_action) {
                return rule.permission;
            }
        }

        // Fall back to generic action check
        self.check(&action)
    }

    /// Get all rules
    pub fn rules(&self) -> &[PermissionRule] {
        &self.rules
    }
}

impl Default for PermissionEngine {
    fn default() -> Self {
        Self::new(AgentMode::Plan)
    }
}

/// Check if a shell command is dangerous (destructive, network exfiltration, etc.).
/// Used both to decide `Permission::Ask` in the permission engine and to set the
/// `is_dangerous` flag on approval requests.
pub fn is_dangerous_command(cmd: &str) -> bool {
    let cmd_lower = cmd.to_lowercase();

    // Known dangerous commands
    let dangerous = [
        "rm ",
        "rm -rf",
        "rm -rf /",
        ":(){ :|:& };:",
        "dd if=",
        "mkfs",
        "format",
        "fdisk",
        "shutdown",
        "reboot",
        "poweroff",
        "halt",
        "curl",
        "wget",
        "nc ",
        "netcat",
    ];

    for dangerous_cmd in dangerous {
        if cmd_lower.contains(dangerous_cmd) {
            return true;
        }
    }

    // Commands with pipes or redirects that could be dangerous
    if cmd_lower.contains('|') || cmd_lower.contains(">") {
        // Could be data exfiltration
        return true;
    }

    false
}

/// True when a command chains or substitutes other commands. Safe-command
/// auto-approval only covers a single simple command: `cargo check && curl x`
/// must not inherit the `cargo check` allowance.
fn shell_composes(cmd: &str) -> bool {
    const TOKENS: [&str; 7] = ["&&", "||", ";", "|", "`", "$(", "\n"];
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
    fn test_permission_display() {
        assert!(Permission::Allow.is_allowed());
        assert!(!Permission::Deny.is_allowed());
        assert!(Permission::Ask.is_allowed());
        assert!(Permission::Ask.requires_prompt());
    }

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
    }

    #[test]
    fn test_plan_mode_defaults() {
        let engine = PermissionEngine::new(AgentMode::Plan);

        // Read operations should be allowed
        assert_eq!(engine.check("tool:read_file"), Permission::Allow);
        assert_eq!(engine.check("file:read"), Permission::Allow);

        // Write operations are denied in Plan mode
        assert_eq!(engine.check("tool:write_file"), Permission::Deny);
        assert_eq!(engine.check("tool:edit_file"), Permission::Deny);
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

        // Most operations allowed
        assert_eq!(engine.check("tool:write_file"), Permission::Allow);
        assert_eq!(engine.check("tool:edit_file"), Permission::Allow);
        // Every shell call in Build mode asks for approval.
        assert_eq!(engine.check("tool:shell"), Permission::Ask);
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
        assert_eq!(engine.check("tool:write_file"), Permission::Deny);
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
}
