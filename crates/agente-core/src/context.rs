use crate::types::Message;

pub mod compaction;

pub use compaction::{
    build_summarization_messages, normalize_tool_messages, normalize_tool_messages_tracked,
    serialize_conversation, CompactionResult, CompactionStrategy, ContextCompactor, LlmSummarizer,
    SummarizeError, Summarizer, Summary, SummaryMetadata, SummaryType, SUMMARIZATION_PROMPT,
    SUMMARIZATION_SYSTEM_PROMPT, UPDATE_SUMMARIZATION_PROMPT,
};

pub struct ContextManager {
    max_tokens: usize,
    messages: Vec<Message>,
    system_prompt: String,
}

impl ContextManager {
    pub fn new(max_tokens: usize, system_prompt: String) -> Self {
        Self {
            max_tokens,
            messages: Vec::new(),
            system_prompt,
        }
    }

    pub fn add_message(&mut self, message: Message) {
        self.messages.push(message);
    }

    pub fn add_messages(&mut self, messages: Vec<Message>) {
        self.messages.extend(messages);
    }

    pub fn compact(&mut self) {
        let estimated_tokens = self.estimate_tokens();

        if estimated_tokens > self.max_tokens {
            self.adaptive_compact();
        }
    }

    fn estimate_tokens(&self) -> usize {
        let mut total = self.system_prompt.len() / 4;

        for msg in &self.messages {
            total += msg.content.len() / 4;
            if let Some(tool_calls) = &msg.tool_calls {
                for tc in tool_calls {
                    total += tc.function.name.len() / 4;
                    total += tc.function.arguments.len() / 4;
                }
            }
        }

        total
    }

    fn adaptive_compact(&mut self) {
        if self.messages.len() <= 4 {
            return;
        }

        let mut to_remove = Vec::new();
        let mut token_budget = self.max_tokens;

        let system_tokens = self.system_prompt.len() / 4;
        token_budget -= system_tokens;

        let recent_count = 4.min(self.messages.len());
        for i in (self.messages.len() - recent_count)..self.messages.len() {
            let msg_tokens = self.messages[i].content.len() / 4;
            token_budget -= msg_tokens;
        }

        let mut i = 0;
        while i < self.messages.len() - recent_count && token_budget == 0 {
            let msg = &self.messages[i];
            let msg_tokens = msg.content.len() / 4;
            let compaction_ratio = if i < self.messages.len() / 3 {
                0.2
            } else if i < self.messages.len() * 2 / 3 {
                0.5
            } else {
                0.8
            };

            if compaction_ratio < 1.0 {
                let original = self.messages[i].content.clone();
                let lines: Vec<&str> = original.lines().collect();
                let keep_count = (lines.len() as f32 * compaction_ratio).ceil() as usize;
                let kept: Vec<&str> = lines.iter().take(keep_count).cloned().collect();
                let summary = format!(
                    "[Compacted: {} lines summarized]\n{}",
                    lines.len() - keep_count,
                    kept.join("\n")
                );
                let original_len = original.len();
                self.messages[i].content = summary.clone();
                token_budget += (original_len - summary.len()) / 4;
            } else {
                to_remove.push(i);
                token_budget += msg_tokens;
            }

            i += 1;
        }

        for i in to_remove.into_iter().rev() {
            self.messages.remove(i);
        }
    }

    pub fn get_messages(&self) -> Vec<Message> {
        let mut messages = vec![Message {
            role: crate::types::Role::System,
            content: self.system_prompt.clone(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }];

        messages.extend(self.messages.clone());
        messages
    }

    pub fn clear(&mut self) {
        self.messages.clear();
    }

    pub fn message_count(&self) -> usize {
        self.messages.len()
    }
}

/// Tokens the tool schemas add to every request; the message estimate never
/// sees them, and with dozens of tools they are thousands of tokens.
pub fn estimate_tool_definition_tokens(tools: &[crate::types::ToolDefinition]) -> usize {
    tools
        .iter()
        .map(|tool| {
            (tool.name.len() + tool.description.len() + tool.parameters.to_string().len()) / 4 + 8
        })
        .sum()
}

/// Estimate the number of tokens in a slice of messages using the standard
/// "1 token ≈ 4 characters" heuristic plus a flat 10-token overhead per tool
/// call. Used by the status bar and the auto-compact strategy; deliberately
/// cheap and dependency-free so callers can run it on every render.
pub fn estimate_message_tokens(messages: &[crate::types::Message]) -> usize {
    messages
        .iter()
        .map(|m| {
            let tool_tokens = m
                .tool_calls
                .as_ref()
                .map(|calls| {
                    calls
                        .iter()
                        .map(|tc| tc.function.name.len() / 4 + tc.function.arguments.len() / 4 + 10)
                        .sum::<usize>()
                })
                .unwrap_or(0);
            let media: usize = m
                .attachments
                .iter()
                .map(crate::media::estimated_tokens)
                .sum();
            m.content.len() / 4 + tool_tokens + media
        })
        .sum()
}

/// Marker embedded in the AGENTS.md reminder message so re-injection can be
/// idempotent across turns and after compaction.
pub const PROJECT_REMINDER_MARKER: &str = "<system-reminder>";

/// Max bytes of AGENTS.md delivered per session (keeps prompt growth bounded;
/// the system prompt itself stays small).
const AGENTS_MD_BUDGET_BYTES: usize = 8 * 1024;

/// Read `{project}/AGENTS.md` (created by `/init`) as a user-message
/// reminder. `None` when the file is missing or empty. The system prompt
/// stays small and cacheable; per-project context travels as a reminder.
pub fn agents_md_reminder(project_dir: &str) -> Option<String> {
    let path = std::path::Path::new(project_dir).join("AGENTS.md");
    let content = std::fs::read_to_string(&path).ok()?;
    let content = content.trim();
    if content.is_empty() {
        return None;
    }
    let truncated = if content.len() > AGENTS_MD_BUDGET_BYTES {
        format!(
            "{}\n\n[AGENTS.md truncated at {} bytes]",
            crate::util::truncate_at_char_boundary(content, AGENTS_MD_BUDGET_BYTES),
            AGENTS_MD_BUDGET_BYTES
        )
    } else {
        content.to_string()
    };
    Some(format!(
        "{PROJECT_REMINDER_MARKER}\nProject instructions from AGENTS.md (authoritative for this workspace):\n{truncated}\n{PROJECT_REMINDER_MARKER}"
    ))
}

/// Whether the conversation already carries the project-reminder message.
pub fn has_project_reminder(messages: &[crate::types::Message]) -> bool {
    conversation_has_reminder(messages.iter().map(|m| m.content.as_str()))
}

/// Content-only variant for callers whose message types are not
/// `crate::types::Message` (the runtime speaks protocol messages).
pub fn conversation_has_reminder<'a, I>(contents: I) -> bool
where
    I: IntoIterator<Item = &'a str>,
{
    contents
        .into_iter()
        .any(|c| c.contains(PROJECT_REMINDER_MARKER))
}

/// Inject the AGENTS.md reminder after the system message when absent.
/// Idempotent: a conversation that already carries it (or has none to read)
/// is returned unchanged.
pub fn inject_project_reminder(messages: &mut Vec<crate::types::Message>, project_dir: &str) {
    if has_project_reminder(messages) {
        return;
    }
    let Some(reminder) = agents_md_reminder(project_dir) else {
        return;
    };
    let insert_at = messages
        .iter()
        .position(|m| m.role == crate::types::Role::System)
        .map(|i| i + 1)
        .unwrap_or(0);
    messages.insert(
        insert_at,
        crate::types::Message {
            role: crate::types::Role::User,
            content: reminder,
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
    );
}

/// Generate the Plan-mode restriction from the ACTUAL filtered toolset
/// instead of a hardcoded tool-name list, so new tools are respected
/// automatically. `allowed` = tools visible in Plan mode, `blocked` = the
/// mutating ones hidden by the gate.
pub fn plan_mode_restriction(allowed: &[String], blocked: &[String]) -> String {
    let allowed_text = if allowed.is_empty() {
        "no tools".to_string()
    } else {
        allowed.join(", ")
    };
    let blocked_text = if blocked.is_empty() {
        "none".to_string()
    } else {
        blocked.join(", ")
    };
    format!(
        "\n\nIMPORTANT: You are in PLAN mode. You must NOT make any code changes. \
         Use only {allowed_text}. Do NOT use {blocked_text}. \
         When the plan is ready, call present_plan(title, markdown) once — that writes \
         its own file under `.agente/plans/` and shows the user Accept / Redo / Comment. \
         Do not implement the plan until the user Accepts."
    )
}

#[cfg(test)]
mod prompt_budget_tests {
    use super::*;

    /// The system prompt is a *minimal* base (a 16 KB ceiling on templates): tool-specific instructions live in each
    /// tool's own description, and per-project context travels as a
    /// user-message reminder — never inside this string.
    #[test]
    fn executor_prompt_stays_under_the_sixteen_kb_budget() {
        let registry = crate::tools::ToolRegistry::new("/tmp/project");
        let prompt = executor_system_prompt_with_tools("/tmp/project", "", &registry.definitions());
        assert!(
            prompt.len() <= 16 * 1024,
            "system prompt grew to {} bytes; keep the base minimal and push              tool instructions into tool descriptions",
            prompt.len()
        );
    }

    #[test]
    fn agents_md_reminder_is_idempotent_and_budgeted() {
        let dir = std::env::temp_dir().join(format!("agents-md-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("AGENTS.md"),
            "# Rules
- keep it small
",
        )
        .unwrap();

        let reminder =
            agents_md_reminder(dir.to_str().unwrap()).expect("reminder for existing file");
        assert!(reminder.contains(PROJECT_REMINDER_MARKER));
        assert!(reminder.contains("keep it small"));

        let mut messages = vec![crate::types::Message {
            role: crate::types::Role::System,
            content: "system".into(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }];
        inject_project_reminder(&mut messages, dir.to_str().unwrap());
        assert_eq!(messages.len(), 2);
        // Second injection is a no-op.
        inject_project_reminder(&mut messages, dir.to_str().unwrap());
        assert_eq!(messages.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agents_md_over_budget_is_truncated_safely() {
        let dir = std::env::temp_dir().join(format!("agents-md-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = "x".repeat(20 * 1024);
        std::fs::write(dir.join("AGENTS.md"), &big).unwrap();
        let reminder = agents_md_reminder(dir.to_str().unwrap()).unwrap();
        assert!(
            reminder.len() < 9 * 1024,
            "budget exceeded: {}",
            reminder.len()
        );
        assert!(reminder.contains("truncated"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

pub fn planner_system_prompt() -> String {
    r#"You are a planning agent for a coding assistant. Your role is to:
1. Analyze the user's task
2. Break it down into clear, actionable steps
3. Create a structured plan

Output your response in this format:
REASONING: <your analysis of the task>
PLAN:
1. <step 1>
2. <step 2>
...

Be specific and actionable in your steps. Consider file operations, code changes, and verification steps."#
        .to_string()
}

pub fn executor_system_prompt(project_dir: &str, memory_context: &str) -> String {
    executor_system_prompt_with_tools(project_dir, memory_context, &[])
}

/// Render the "You have access to these tools:" block from the actual tool
/// registry, so the prompt never drifts from what the model can call.
fn render_tool_list(tools: &[crate::types::ToolDefinition]) -> String {
    if tools.is_empty() {
        return "You have access to tools exposed through the tool schema of this request."
            .to_string();
    }
    let mut out = String::from("You have access to these tools:");
    for t in tools {
        // The subagent family needs its full mechanics in the prompt: the
        // first line alone never mentions background execution or polling,
        // so the model spawns a background task and never retrieves it.
        if matches!(t.name.as_str(), "task" | "task_output" | "kill_task") {
            out.push_str(&format!("\n- {} — {}", t.name, t.description));
        } else {
            let first_line = t.description.lines().next().unwrap_or("");
            out.push_str(&format!("\n- {} — {}", t.name, first_line));
        }
    }
    if tools
        .iter()
        .any(|t| t.name == crate::extensions::skills::SKILL_TOOL)
    {
        out.push_str(
            "\n\nSkills: the `skill` tool's description lists the installed skills. When a \
             request matches one, load it before starting and follow its instructions.",
        );
    }
    out
}

/// Executor system prompt with a dynamically generated tool list.
///
/// The tool list is derived from the same registry the agent loop uses, so it
/// always reflects the tools actually available (including web_fetch,
/// web_search, present_plan, and the hosted subagent `task` family).
pub fn executor_system_prompt_with_tools(
    project_dir: &str,
    memory_context: &str,
    tools: &[crate::types::ToolDefinition],
) -> String {
    let identity = format!("You are Agente, an expert coding agent working in: {project_dir}");
    system_prompt_for(&identity, memory_context, tools)
}

/// A named bot's system prompt: its persona (who it is, what it remembers,
/// its teammates) in place of the default identity, then the same working
/// method, safety rules and tool list as every agent.
pub fn bot_system_prompt(
    persona: &str,
    project_dir: &str,
    tools: &[crate::types::ToolDefinition],
) -> String {
    let identity = format!(
        "{}

You work in: {project_dir}",
        persona.trim_end()
    );
    system_prompt_for(&identity, "", tools)
}

fn system_prompt_for(
    identity: &str,
    memory_context: &str,
    tools: &[crate::types::ToolDefinition],
) -> String {
    let memory_section = if memory_context.is_empty() {
        String::new()
    } else {
        format!(
            r#"PROJECT MEMORY (accumulated knowledge from previous sessions):
{memory_context}

"#
        )
    };

    format!(
        r#"{}

{}{}

WORKING METHOD:
1. Understand — read the relevant files before acting. Never guess file contents,
   symbols, or APIs; gather them with the tools. When the answer spans more than
   a few files, or you do not know where to look, spawn one `explore` child
   instead of running serial greps yourself — it keeps this context clean.
2. Plan — for multi-step tasks, track progress with todo_write so the user can see
   where you are. In plan mode, present a plan before any changes.
3. Act — batch independent tool calls in a single response (e.g. read_file on several
   files at once, or grep + list_dir together). Dependent steps (read → edit →
   verify) wait for results.
4. Verify — after editing, check your work: re-read what you changed, and run the
   project's build/tests when practical (cargo check, cargo test, or the equivalent
   for the stack at hand). Fix what you broke before reporting success.
5. Report — end with a concise summary: what changed (file paths), how it was
   verified, and any follow-ups.

TOOL USAGE:
- Always read a file before editing it; prefer edit_file or apply_patch over write_file for targeted
  changes, and keep edits minimal and consistent with the existing code style.
- Start with file_outline or focused grep; read only the relevant file ranges.
  Reuse gathered context and avoid repeating unchanged reads or tool output.
- Use grep/find to locate symbols and definitions instead of guessing the file layout.
- Use web_search for up-to-date information (APIs, docs, versions, error messages),
  then web_fetch the most relevant result for detail. Cite URLs when you rely on
  external sources.
- Shell commands should be purposeful: use the project's own tooling for verification
  (cargo check / cargo test / npm test / …) and never run destructive commands
  (rm -rf, git reset --hard, force pushes) without explicit user intent.
- Subagents (the `task` tool) keep bulky research out of this context. Spawn
  `explore` for open-ended codebase questions — "where is X handled", "find
  every caller of Y", "how does Z flow" — instead of reading file after file
  yourself; spawn `plan` when you need an implementation plan from an
  investigation. Both run inline and return their result. `general-purpose` runs
  in the background by default: continue with other work and wait for the
  completion notice before reporting anything that depends on it — do NOT poll
  `task_output` in a loop; use it only to peek at a running child. Never present
  a spawn as done. Spawning is not free: every child runs its own model calls
  (nesting is capped at depth 3 — prefer a flat fan-out over chains). When
  parallel children touch files, partition ownership up front (one child per
  area) so their edits never collide; combine the results yourself. If all
  concurrency slots are busy a spawn queues instead of failing — collect it with
  `task_output` when it starts.

QUALITY:
- Do not fabricate tool results or file contents — if you lack information, gather it.
- If a tool errors, diagnose the error and retry with a corrected approach instead of
  abandoning the task. If you are genuinely blocked, say exactly what you need.
- Do not claim work is done until it is verified. A failing build or test is an
  unfinished task.

SAFETY:
- Never commit or push unless explicitly requested.
- Never delete files or data without explicit user intent.
- Be careful with shell commands — preview risky operations first.

RESPONSE FORMAT:
- Be concise. Briefly state your plan, then act.
- Prefer short paragraphs and lists. Use tables only for compact comparisons;
  avoid HTML and prose-heavy tables. Do not repeat tool logs in the final answer.
- Final message: what changed, what was verified, and any follow-ups."#,
        identity,
        memory_section,
        render_tool_list(tools)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FunctionCall, Message, Role, ToolCall, ToolDefinition};

    fn user(content: impl Into<String>) -> Message {
        Message {
            role: Role::User,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }
    }

    fn def(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: format!("{name} does work."),
            parameters: serde_json::json!({}),
        }
    }

    #[test]
    fn a_bot_prompt_leads_with_its_persona() {
        let prompt = bot_system_prompt(
            "You are Colina (@colina).\n",
            "/bots/colina",
            &[def("read_file")],
        );
        assert!(prompt.starts_with("You are Colina (@colina).\n\nYou work in: /bots/colina\n"));
        assert!(!prompt.contains("You are Agente"));
        assert!(prompt.contains("WORKING METHOD:"));
        assert!(prompt.contains("- read_file"));
    }

    #[test]
    fn dynamic_tool_list_reflects_registry() {
        let tools = vec![def("read_file"), def("web_fetch"), def("task")];
        let prompt = executor_system_prompt_with_tools("/proj", "", &tools);
        assert!(prompt.contains("- read_file — read_file does work."));
        assert!(prompt.contains("- web_fetch — web_fetch does work."));
        assert!(prompt.contains("- task — task does work."));
        // The stale hardcoded list is gone: nothing hardcodes tool arity.
        assert!(prompt.contains("You have access to these tools:"));
    }

    #[test]
    fn empty_tool_list_uses_fallback_line() {
        let prompt = executor_system_prompt_with_tools("/proj", "", &[]);
        assert!(prompt.contains("exposed through the tool schema"));
    }

    #[test]
    fn task_family_renders_full_mechanics_in_prompt() {
        let mut task_def = def("task");
        task_def.description = "Spawn a subagent with a restricted toolset.\nBy default subagents run in the background and return a task_id immediately; pass run_in_background=false to wait inline. Use task_output to fetch a background result and kill_task to cancel one.".to_string();
        let tools = vec![def("read_file"), task_def];
        let prompt = executor_system_prompt_with_tools("/proj", "", &tools);
        // The model must see the background/polling mechanics, not just the
        // first line — otherwise it spawns and never retrieves the result.
        assert!(prompt.contains("run_in_background"));
        assert!(prompt.contains("Use task_output"));
        // Unrelated tools stay first-line summaries (no prompt bloat).
        assert!(prompt.contains("- read_file — read_file does work."));
        // And the executor guidance teaches notification over polling.
        assert!(prompt.contains("task_output"));
        assert!(prompt.contains("completion notice"));
        // Delegation must have an explicit trigger, not just a tool list.
        assert!(prompt.contains("spawn one `explore` child"));
        // Fan-out discipline: partition ownership, flat over chains, queue note.
        assert!(prompt.contains("partition ownership up front"));
        assert!(prompt.contains("depth 3"));
        assert!(prompt.contains("queues instead of"));
    }

    #[test]
    fn estimate_message_tokens_scales_with_content_and_tools() {
        let msgs = vec![user("a".repeat(400))];
        let plain = estimate_message_tokens(&msgs);
        // 400 chars ≈ 100 tokens at the 4-char-per-token heuristic.
        assert_eq!(plain, 100);

        let with_tool = vec![Message {
            role: Role::Assistant,
            content: String::new(),
            tool_calls: Some(vec![ToolCall {
                id: "c1".into(),
                call_type: "function".into(),
                function: FunctionCall {
                    name: "read_file".into(),
                    arguments: "{\"path\":\"src/main.rs\"}".into(),
                },
            }]),
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }];
        let tool_est = estimate_message_tokens(&with_tool);
        // name len/4 + args len/4 + 10 flat overhead.
        let args = r#"{"path":"src/main.rs"}"#;
        assert_eq!(tool_est, "read_file".len() / 4 + args.len() / 4 + 10);
    }

    #[test]
    fn estimate_message_tokens_is_monotonic_in_length() {
        let short = estimate_message_tokens(&[user("hi")]);
        let long = estimate_message_tokens(&[user("a".repeat(10_000))]);
        assert!(long > short);
        assert!(long >= 2_000);
    }
}
