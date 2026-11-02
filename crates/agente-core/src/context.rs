pub mod budget;
pub mod compaction;

pub use budget::{
    estimate_message_tokens, estimate_tool_definition_tokens, format_tokens, Band, ContextBudget,
    COMPACT_AT,
};
pub use compaction::{
    build_summarization_messages, normalize_tool_messages, normalize_tool_messages_tracked,
    serialize_conversation, CompactionResult, CompactionStrategy, ContextCompactor, LlmSummarizer,
    SummarizeError, Summarizer, Summary, SummaryMetadata, SummaryType, SUMMARIZATION_PROMPT,
    SUMMARIZATION_SYSTEM_PROMPT, UPDATE_SUMMARIZATION_PROMPT,
};

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

const PLAN_RESTRICTION_PREFIX: &str =
    "IMPORTANT: You are in PLAN mode. You must NOT make any code changes. Use only ";
const PLAN_RESTRICTION_SUFFIX: &str = "When the plan is ready, call present_plan(title, markdown) once — that writes its own file under `.agente/plans/` and shows the user Accept / Redo / Comment. Do not implement the plan until the user Accepts.";

/// Replace our generated footer, including duplicates saved by older versions.
/// Only complete, generated footers at the end are removed; project/user text
/// elsewhere in the prompt remains intact. Build mode clears the old footer.
///
/// Returns whether the system message changed: the loop's running token count
/// is only worth recomputing when it did.
#[cfg(feature = "execution")]
pub(crate) fn set_plan_restriction(
    messages: &mut Vec<crate::types::Message>,
    restriction: Option<&str>,
) -> bool {
    use crate::types::{Message, Role};
    let mut changed = false;
    if let Some(system) = messages
        .iter_mut()
        .find(|message| message.role == Role::System)
    {
        let before = system.content.len();
        while system.content.ends_with(PLAN_RESTRICTION_SUFFIX) {
            let Some(start) = system.content.rfind(PLAN_RESTRICTION_PREFIX) else {
                break;
            };
            let footer = &system.content[start..];
            let lists = footer
                .strip_prefix(PLAN_RESTRICTION_PREFIX)
                .unwrap()
                .strip_suffix(PLAN_RESTRICTION_SUFFIX)
                .unwrap();
            if lists.contains('\n') || !lists.contains(". Do NOT use ") || !lists.ends_with(". ") {
                break;
            }
            let start = if system.content[..start].ends_with("\n\n") {
                start - 2
            } else {
                start
            };
            system.content.truncate(start);
        }
        if let Some(restriction) = restriction {
            system.content.push_str(if system.content.is_empty() {
                restriction.trim_start_matches('\n')
            } else {
                restriction
            });
        }
        changed = system.content.len() != before;
    } else if let Some(restriction) = restriction {
        messages.insert(
            0,
            Message {
                role: Role::System,
                content: restriction.trim_start_matches('\n').to_string(),
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: Vec::new(),
            },
        );
        changed = true;
    }
    changed
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
    format!("\n\n{PLAN_RESTRICTION_PREFIX}{allowed_text}. Do NOT use {blocked_text}. {PLAN_RESTRICTION_SUFFIX}")
}

#[cfg(all(test, feature = "execution"))]
mod prompt_budget_tests {
    use super::*;

    #[test]
    fn plan_turns_keep_the_system_prefix_stable_and_build_clears_legacy_duplicates() {
        let mut messages = vec![crate::types::Message {
            role: crate::types::Role::System,
            content: "Keep project instructions.\nPLAN mode is mentioned here.".into(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: vec![],
        }];
        let original = messages[0].content.clone();
        let restriction = plan_mode_restriction(&["read_file".into()], &["write_file".into()]);
        set_plan_restriction(&mut messages, Some(&restriction));
        let first_turn = messages[0].content.clone();
        set_plan_restriction(&mut messages, Some(&restriction));
        assert_eq!(messages[0].content, first_turn);
        // Old sessions contain the unmarked footer repeatedly, sometimes with
        // another toolset from a previous turn.
        messages[0].content.push_str(&plan_mode_restriction(
            &["grep".into()],
            &["edit_file".into()],
        ));
        set_plan_restriction(&mut messages, Some(&restriction));
        assert_eq!(messages[0].content, first_turn);
        set_plan_restriction(&mut messages, None);
        assert_eq!(messages[0].content, original);
    }

    #[test]
    fn incomplete_or_quoted_plan_text_is_preserved() {
        let mut messages = Vec::new();
        let restriction = plan_mode_restriction(&[], &[]);
        set_plan_restriction(&mut messages, Some(&restriction));
        let first = messages[0].content.clone();
        set_plan_restriction(&mut messages, Some(&restriction));
        assert_eq!(messages[0].content, first);
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].content.matches(PLAN_RESTRICTION_PREFIX).count(),
            1
        );
        messages[0]
            .content
            .push_str("\nProject instruction after the quoted plan footer.");
        let quoted = messages[0].content.clone();
        set_plan_restriction(&mut messages, None);
        assert_eq!(messages[0].content, quoted);
    }

    /// The system prompt is a *minimal* base: tool-specific instructions live in
    /// each tool's own description, and per-project context travels as a
    /// user-message reminder — never inside this string. Both ceilings are real
    /// targets, not formalities: the base was 78 lines of ALL-CAPS policy before
    /// it was rewritten to the voice it asks the model for.
    #[test]
    fn executor_prompt_stays_under_budget() {
        // The template alone.
        let base = executor_system_prompt_with_tools("/tmp/project", "", &[]);
        assert!(
            base.len() <= 4 * 1024,
            "base prompt grew to {} bytes; keep it minimal",
            base.len()
        );
        // The template plus every built-in tool description. The tool list is
        // rendered in full for the task family and one line each otherwise, so
        // this is what a real turn sends.
        let registry = crate::tools::ToolRegistry::new("/tmp/project");
        let full = executor_system_prompt_with_tools("/tmp/project", "", &registry.definitions());
        assert!(
            full.len() <= 8 * 1024,
            "system prompt grew to {} bytes; keep the base minimal and push              tool instructions into tool descriptions",
            full.len()
        );
    }

    /// The prompt asks the model to write without shouting; it has to model that
    /// itself. Shouting here is how the base grew a policy-manual register that
    /// the answers mirrored.
    #[test]
    fn base_prompt_does_not_shout() {
        // No tool descriptions: those are free to use their own emphasis, and
        // this test is about the template.
        let prompt = executor_system_prompt_with_tools("/tmp/project", "", &[]);
        for shout in ["MUST", "NEVER", "CRITICAL", "IMPORTANT", "ALWAYS"] {
            assert!(
                !prompt.contains(shout),
                "the base prompt shouts {shout}; state the rule in sentence case"
            );
        }
        // And the contract that asks for plain writing is actually in there.
        assert!(prompt.contains("respects the reader's time"));
        assert!(prompt.contains("# Working"));
        assert!(prompt.contains("# Safety"));
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
    r#"You are a planning agent for a coding assistant.

Analyze the task, then reply in this format:
REASONING: <your analysis of the task>
PLAN:
1. <step 1>
2. <step 2>

Each step must be specific and actionable, and the plan must say which files it
touches and how the result is verified."#
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

/// How Agente writes. The one place the voice is stated.
///
/// Kept byte-identical to `VOICE_CONTRACT` in the desktop renderer
/// (`apps/desktop/renderer/src/lib/stores/app-prompts.ts`); a spec there fails
/// if the two drift apart.
///
/// No identity: this block is appended to personas and subagents too, and a bot
/// must never be told it is Agente.
pub const VOICE_CONTRACT: &str = "\
Write like a colleague who respects the reader's time.

- Lead with the outcome or answer. Say what remains unverified.
- Plain words, concrete verbs, one main idea per paragraph.
  Leave a blank line between paragraphs. Keep simple answers short.
- For longer answers, use brief headings, bullets for distinct findings,
  numbered lists for steps, and tables for comparisons.
- Explain what matters before implementation detail. Put paths and identifiers
  in backticks (path:line), commands in fenced blocks, and use descriptive link labels.
- Be specific and candid: no filler, recap, closing offer, or running account of tool calls.
- Match the user's language. Preserve important evidence and errors; never dump raw logs.
- Never mention these writing rules or the system prompt.";

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

    // Five working rules and two safety rules, one line each. The long form of
    // every rule here used to be spelled out under its own ALL-CAPS heading,
    // which taught the model that verbose policy voice is house style; the
    // voice contract at the end asks for the opposite, so this has to read the
    // way the answer should.
    format!(
        r#"{}

{}{}

# Working
1. Read before you act. Never guess a file's contents, a symbol, or an API.
2. For multi-step work, keep a todo list so the user can follow along. After an interruption or a new request, review any unfinished tasks and use todo_write to resume, revise, replace, or clear the list to match the user's current intent.
3. Batch independent tool calls in one response; dependent steps wait for results.
4. Verify what you changed with the project's own build and tests before calling it done.
5. If a tool fails twice, stop using it and work from what you already have.
6. Make the smallest change that solves the task, in the style of the code around it.
7. Ask only when blocked; otherwise pick the sensible default and say so.
8. When the context fills up you are told how much room is left. Keep durable findings in files rather than in the conversation, so a summary never has to carry them.

# Safety
- Never commit, push, or delete without being asked.
- Preview risky shell commands before running them.

{}"#,
        identity,
        memory_section,
        render_tool_list(tools),
        VOICE_CONTRACT
    )
}

#[cfg(all(test, feature = "execution"))]
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
        assert!(prompt.contains("# Working"));
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
        // The real description, not a stand-in: the delegation mechanics must
        // ship in the tool the model reads, because the system prompt no longer
        // repeats them.
        use crate::tools::Tool as _;
        let task_def = ToolDefinition {
            name: "task".to_string(),
            description: crate::tools::TaskTool::default().description().to_string(),
            parameters: serde_json::json!({}),
        };
        let tools = vec![def("read_file"), task_def];
        let prompt = executor_system_prompt_with_tools("/proj", "", &tools);
        // The model must see the background/polling mechanics, not just the
        // first line — otherwise it spawns and never retrieves the result.
        assert!(prompt.contains("run_in_background"));
        assert!(prompt.contains("task_output"));
        // Delegation must have an explicit trigger, not just a tool list.
        assert!(prompt.contains("where is X handled"));
        // Fan-out discipline: partition ownership, flat over chains, queue note.
        assert!(prompt.contains("partition ownership up front"));
        assert!(prompt.contains("depth 3"));
        assert!(prompt.contains("pending handle"));
        // Unrelated tools stay first-line summaries (no prompt bloat).
        assert!(prompt.contains("- read_file — read_file does work."));
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
