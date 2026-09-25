//! Tool execution pipeline: permission-gated preparation, execution with
//! progress/heartbeat context, result finalization, and the three batch
//! strategies (sequential, parallel, mixed batched).

use std::sync::mpsc::Sender;
use std::sync::Arc;

use crate::cancellation::AbortSignal;
use crate::permissions::{ApprovalBroker, SharedPermissionEngine};
use crate::subagent::SubagentHost;
use crate::tools::{ToolExecutionContext, ToolOutputStream, ToolRegistry};
use crate::types::{ApprovalAction, ToolCall};

use super::approval::{build_approval_request, check_missing_args};
use super::args::{normalize_tool_args, parse_tool_args};
use super::config::{send_event, PreparedToolCall, ToolCallOutcome};
use crate::agent::events::{AgentEvent, AgentTaskEvent};
use crate::todo::TodoInput;
use crate::util::clean_path;

/// Check if a tool should be auto-approved based on configuration.
/// For Ask permissions, sends an approval request to the UI and waits for response.
// Box-free Err: the failure path is cold (bad args / denied permission) and
// callers collect the outcome by value into `Vec<ToolCallOutcome>` regardless,
// so boxing would churn every construction site for no real gain.
#[allow(clippy::too_many_arguments, clippy::result_large_err)]
pub(crate) async fn prepare_tool_call(
    tool_call: &ToolCall,
    tool_registry: &ToolRegistry,
    permission_engine: &SharedPermissionEngine,
    sender: &Sender<AgentTaskEvent>,
    task_id: u64,
    broker: &ApprovalBroker,
    cancel_signal: &AbortSignal,
    project_dir: &str,
) -> Result<PreparedToolCall, ToolCallOutcome> {
    let tool_name = &tool_call.function.name;
    tracing::info!(task_id, tool_id = %tool_call.id, tool = %tool_name, "Tool proposed");
    let args = normalize_tool_args(tool_name, parse_tool_args(&tool_call.function.arguments));

    if let Some(outcome) = check_missing_args(&tool_call.id, tool_name, &args) {
        return Err(outcome);
    }

    if tool_registry.get(tool_name).is_none() {
        return Err(ToolCallOutcome {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_name.clone(),
            content: format!("Error: Unknown tool '{tool_name}'"),
            is_error: true,
            path_changed: None,
            changed_path: None,
            file_before: None,
            file_after: None,
            todos: None,
        });
    }

    let mode = permission_engine
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .mode;
    if !tool_registry.is_allowed_in_mode(tool_name, mode) {
        return Err(ToolCallOutcome {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_name.clone(),
            content: format!("Error: Tool '{tool_name}' is not allowed in current mode"),
            is_error: true,
            path_changed: None,
            changed_path: None,
            file_before: None,
            file_after: None,
            todos: None,
        });
    }

    // Check permission using the permission engine. Filesystem facts are
    // collected BEFORE the lock so slow disks never stall other permission
    // decisions while the shared engine is held.
    let facts = crate::permissions::collect_fs_facts(
        tool_name,
        &args,
        Some(std::path::Path::new(project_dir)),
    );
    let permission = {
        let engine = permission_engine
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        engine.check_tool_with_facts(tool_name, &args, &facts)
    };

    match permission {
        crate::permissions::Permission::Deny => {
            return Err(ToolCallOutcome {
                tool_call_id: tool_call.id.clone(),
                tool_name: tool_name.clone(),
                content: format!("Error: Tool '{tool_name}' is not allowed in current mode"),
                is_error: true,
                path_changed: None,
                changed_path: None,
                file_before: None,
                file_after: None,
                todos: None,
            });
        }
        crate::permissions::Permission::Ask => {
            let request = tokio::select! {
                request = build_approval_request(tool_call, &args, project_dir) => request,
                _ = cancel_signal.wait_aborted() => {
                    return Err(ToolCallOutcome {
                        tool_call_id: tool_call.id.clone(),
                        tool_name: tool_name.clone(),
                        content: format!("Tool '{tool_name}' canceled by user"),
                        is_error: true,
                        path_changed: None,
                        changed_path: None,
                        file_before: None,
                        file_after: None,
                        todos: None,
                    });
                }
            };

            // Register before publishing. A fast UI response must never race
            // the broker and get discarded because no waiter existed yet.
            let mut response_rx = broker.request(&request);
            tracing::info!(task_id, tool_id = %tool_call.id, tool = %tool_name, request_id = %request.request_id, "Tool approval requested");
            send_event(
                sender,
                task_id,
                AgentEvent::ApprovalRequested {
                    source: crate::agent::events::ApprovalSource::Parent,
                    request: request.clone(),
                },
            );
            let approval = tokio::select! {
                resp = &mut response_rx => resp.ok(),
                _ = cancel_signal.wait_aborted() => None,
            };
            // The user may never answer (turn cancelled); drop the pending entry.
            broker.cancel(&request.request_id);
            tracing::info!(task_id, tool_id = %tool_call.id, request_id = %request.request_id, decision = ?approval, "Tool approval resolved");
            match approval {
                Some(ApprovalAction::ApproveOnce) => {
                    // Proceed with execution
                }
                Some(ApprovalAction::ApproveAll) => {
                    // Enable auto-approve in the permission engine and proceed
                    let mut engine = permission_engine
                        .write()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    engine.set_auto_approve(true);
                }
                Some(ApprovalAction::Deny) | Some(ApprovalAction::Cancel) | None => {
                    return Err(ToolCallOutcome {
                        tool_call_id: tool_call.id.clone(),
                        tool_name: tool_name.clone(),
                        content: if cancel_signal.is_aborted() {
                            format!("Tool '{tool_name}' canceled by user")
                        } else {
                            format!("Tool '{tool_name}' was denied by user")
                        },
                        is_error: true,
                        path_changed: None,
                        changed_path: None,
                        file_before: None,
                        file_after: None,
                        todos: None,
                    });
                }
            }
        }
        crate::permissions::Permission::Allow => {
            // Proceed with tool execution
        }
    }

    let file_before = if matches!(
        tool_name.as_str(),
        "write_file" | "edit_file" | "apply_patch"
    ) {
        if let Some(path) = args.get("path").and_then(|value| value.as_str()) {
            match crate::tools::resolve_project_path(path, project_dir) {
                Ok(resolved) => Some((
                    clean_path(path),
                    tokio::fs::read_to_string(resolved).await.ok(),
                )),
                Err(_) => None,
            }
        } else {
            None
        }
    } else {
        None
    };

    Ok(PreparedToolCall {
        tool_call: tool_call.clone(),
        args,
        file_before,
    })
}

/// Hosted subagent tools are executed by the SubagentHost, not the registry.
fn is_hosted_tool(name: &str) -> bool {
    matches!(name, "task" | "task_output" | "kill_task")
}

/// Execute a hosted subagent tool call. The caller must have checked
/// [`is_hosted_tool`]; when no host is configured the outcome is an error.
async fn execute_hosted_tool(
    host: Option<&SubagentHost>,
    prepared: PreparedToolCall,
    cancel_signal: &AbortSignal,
    sender: &Sender<AgentTaskEvent>,
    task_id: u64,
    depth: u32,
) -> ToolCallOutcome {
    let tool_call_id = prepared.tool_call.id.clone();
    let tool_name = prepared.tool_call.function.name.clone();
    let Some(h) = host else {
        return ToolCallOutcome::error(
            tool_call_id,
            tool_name,
            "Subagents are not available in this mode.",
        );
    };
    let context = build_tool_context(cancel_signal, sender, task_id, &tool_call_id);
    h.execute_hosted_tool_call(&prepared.tool_call, prepared.args, context, depth)
        .await
}

/// Build the execution context for one tool call: incremental output progress
/// plus a liveness heartbeat, both routed to the TUI as agent events. Shared
/// by registry tools and hosted subagent tools so a quiet-but-alive tool
/// never looks dead to the stuck guard.
pub(crate) fn build_tool_context(
    cancel_signal: &AbortSignal,
    sender: &Sender<AgentTaskEvent>,
    task_id: u64,
    tool_call_id: &str,
) -> ToolExecutionContext {
    let progress_sender = sender.clone();
    let progress_id = tool_call_id.to_string();
    let heartbeat_sender = sender.clone();
    let heartbeat_id = tool_call_id.to_string();
    ToolExecutionContext::new(cancel_signal.clone())
        .with_progress(move |progress| {
            let chunk = match progress.stream {
                ToolOutputStream::Stdout => progress.content,
                ToolOutputStream::Stderr => format!("[stderr] {}", progress.content),
            };
            send_event(
                &progress_sender,
                task_id,
                AgentEvent::ToolCallProgress {
                    id: progress_id.clone(),
                    chunk,
                },
            );
        })
        .with_heartbeat(move || {
            send_event(
                &heartbeat_sender,
                task_id,
                AgentEvent::ToolHeartbeat {
                    id: heartbeat_id.clone(),
                },
            );
        })
}

pub(crate) async fn execute_prepared_tool(
    prepared: PreparedToolCall,
    tool_registry: &ToolRegistry,
    cancel_signal: &AbortSignal,
    sender: &Sender<AgentTaskEvent>,
    task_id: u64,
) -> ToolCallOutcome {
    let tool_name = prepared.tool_call.function.name.clone();
    let tool_call_id = prepared.tool_call.id.clone();
    let args = prepared.args.clone();
    let file_before = prepared.file_before.clone();

    let context = build_tool_context(cancel_signal, sender, task_id, &tool_call_id);

    let (raw_content, is_error) = match tool_registry
        .execute_with_context(&tool_name, args.clone(), context)
        .await
    {
        Ok(result) => (result, false),
        Err(e) => (format!("Error: {e}"), true),
    };

    // Tool output is already bounded by the registry (2000 lines / 50 KiB with
    // an explicit truncation marker), so file reads must reach the model
    // intact. A hardcoded "first 10 lines" summary made read_file useless for
    // any file over 30 lines, including explicitly requested ranges.
    let mut content = raw_content;

    let mut path_changed = None;
    let mut changed_path = None;
    let mut before_content = None;
    let mut after_content = None;
    let mut todos = None;

    if !is_error {
        match tool_name.as_str() {
            "write_file" | "edit_file" | "apply_patch" => {
                if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
                    let clean = clean_path(path);
                    let action = match tool_name.as_str() {
                        "write_file" => "wrote",
                        "edit_file" => "edited",
                        _ => "patched",
                    };
                    path_changed = Some(format!("{action} {clean}"));
                    changed_path = Some(clean.clone());

                    // Attach lightweight syntax diagnostics so the model can self-correct
                    // after an edit. Full LSP servers are optional; this
                    // always runs for supported extensions and never fails the tool call.
                    let full_path = {
                        let p = std::path::Path::new(path);
                        if p.is_absolute() {
                            p.to_path_buf()
                        } else {
                            std::path::Path::new(tool_registry.project_dir()).join(p)
                        }
                    };
                    before_content = file_before
                        .as_ref()
                        .filter(|(tracked, _)| tracked == &clean)
                        .and_then(|(_, content)| content.clone());
                    after_content = tokio::fs::read_to_string(&full_path).await.ok();
                    if let Ok(file_content) = tokio::fs::read_to_string(&full_path).await {
                        let diagnostics = crate::lsp::quick_validate_syntax(
                            &full_path.to_string_lossy(),
                            &file_content,
                        );
                        if !diagnostics.is_empty() {
                            content.push_str("\n\n[diagnostics]\n");
                            for d in diagnostics.into_iter().take(12) {
                                content.push_str(&format!("- {d}\n"));
                            }
                            content.push_str(
                                "Fix these issues in a follow-up edit if they are real problems.\n",
                            );
                        }
                    }
                }
            }
            "todo_write" => {
                if let Some(todos_arr) = args.get("todos").and_then(|v| v.as_array()) {
                    let parsed: Vec<TodoInput> = todos_arr
                        .iter()
                        .filter_map(|t| {
                            Some(TodoInput {
                                content: t.get("content")?.as_str()?.to_string(),
                                status: t
                                    .get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("pending")
                                    .to_string(),
                                priority: t
                                    .get("priority")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("medium")
                                    .to_string(),
                            })
                        })
                        .collect();
                    if !parsed.is_empty() {
                        todos = Some(parsed);
                    }
                }
            }
            _ => {}
        }
    }

    ToolCallOutcome {
        tool_call_id,
        tool_name,
        content,
        is_error,
        path_changed,
        changed_path,
        file_before: before_content,
        file_after: after_content,
        todos,
    }
}

pub(crate) fn finalize_tool_result(
    outcome: &ToolCallOutcome,
    sender: &Sender<AgentTaskEvent>,
    task_id: u64,
) {
    tracing::info!(task_id, tool_id = %outcome.tool_call_id, tool = %outcome.tool_name, is_error = outcome.is_error, result_bytes = outcome.content.len(), "Tool finished");
    send_event(
        sender,
        task_id,
        AgentEvent::ToolCallResult {
            id: outcome.tool_call_id.clone(),
            name: outcome.tool_name.clone(),
            result: outcome.content.clone(),
            is_error: outcome.is_error,
        },
    );

    if let Some(ref summary) = outcome.path_changed {
        let path = outcome
            .changed_path
            .clone()
            .unwrap_or_else(|| summary.split_whitespace().last().unwrap_or("").to_string());
        send_event(
            sender,
            task_id,
            AgentEvent::FileChange {
                subagent_id: None,
                path,
                diff_summary: summary.clone(),
                before: outcome.file_before.clone(),
                after: outcome.file_after.clone(),
            },
        );
    }

    if let Some(ref todos) = outcome.todos {
        send_event(
            sender,
            task_id,
            AgentEvent::TodoUpdate {
                subagent_id: None,
                todos: todos.clone(),
            },
        );
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_tool_calls_sequential(
    tool_calls: &[ToolCall],
    tool_registry: Arc<ToolRegistry>,
    sender: Sender<AgentTaskEvent>,
    task_id: u64,
    permission_engine: &SharedPermissionEngine,
    broker: &ApprovalBroker,
    cancel_signal: AbortSignal,
    project_dir: &str,
    depth: u32,
    host: Option<&SubagentHost>,
) -> Vec<ToolCallOutcome> {
    let mut outcomes = Vec::new();
    for tool_call in tool_calls {
        tracing::info!(task_id, tool_id = %tool_call.id, tool = %tool_call.function.name, "Tool started");
        if cancel_signal.is_aborted() {
            tracing::info!("Sequential tool execution cancelled mid-batch");
            break;
        }
        let outcome = match prepare_tool_call(
            tool_call,
            &tool_registry,
            permission_engine,
            &sender,
            task_id,
            broker,
            &cancel_signal,
            project_dir,
        )
        .await
        {
            Ok(prepared) => {
                if is_hosted_tool(prepared.tool_call.function.name.as_str()) {
                    execute_hosted_tool(host, prepared, &cancel_signal, &sender, task_id, depth)
                        .await
                } else {
                    execute_prepared_tool(
                        prepared,
                        &tool_registry,
                        &cancel_signal,
                        &sender,
                        task_id,
                    )
                    .await
                }
            }
            Err(outcome) => outcome,
        };
        finalize_tool_result(&outcome, &sender, task_id);
        let is_error = outcome.is_error;
        outcomes.push(outcome);
        // A failed sequential tool is usually a dependency for the remaining
        // calls in the batch (e.g. write -> edit -> shell). Stop early instead
        // of cascading more failures (pi-style `shouldTerminateToolBatch`).
        if is_error {
            tracing::info!("Sequential tool failed; terminating remaining batch");
            break;
        }
    }
    finalize_skipped_calls(tool_calls, &mut outcomes, &sender, task_id);
    outcomes
}

/// Keep assistant `tool_calls` ↔ tool results paired: calls skipped by an
/// early break (failure, cancellation, parallel abort) get a synthetic error
/// result. Without this, the next provider request carries an orphaned
/// tool_use (400s) and the normalizer strips the whole exchange — including
/// the results that did succeed — so the agent appears to "forget" its
/// progress mid-task.
fn finalize_skipped_calls(
    tool_calls: &[ToolCall],
    outcomes: &mut Vec<ToolCallOutcome>,
    sender: &Sender<AgentTaskEvent>,
    task_id: u64,
) {
    for call in tool_calls {
        if outcomes.iter().any(|o| o.tool_call_id == call.id) {
            continue;
        }
        let outcome = ToolCallOutcome::error(
            call.id.clone(),
            call.function.name.clone(),
            "Skipped: an earlier tool in the batch failed or the turn was interrupted.",
        );
        finalize_tool_result(&outcome, sender, task_id);
        outcomes.push(outcome);
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_tool_calls_parallel(
    tool_calls: &[ToolCall],
    tool_registry: Arc<ToolRegistry>,
    sender: Sender<AgentTaskEvent>,
    task_id: u64,
    permission_engine: &SharedPermissionEngine,
    broker: &ApprovalBroker,
    cancel_signal: AbortSignal,
    project_dir: &str,
    depth: u32,
    host: Option<&SubagentHost>,
) -> Vec<ToolCallOutcome> {
    let mut prepared = Vec::new();
    let mut immediate_errors = Vec::new();

    for tool_call in tool_calls {
        if cancel_signal.is_aborted() {
            tracing::info!("Parallel tool execution cancelled before spawning");
            break;
        }
        match prepare_tool_call(
            tool_call,
            &tool_registry,
            permission_engine,
            &sender,
            task_id,
            broker,
            &cancel_signal,
            project_dir,
        )
        .await
        {
            Ok(p) => prepared.push(p),
            Err(outcome) => immediate_errors.push(outcome),
        }
    }

    let mut results: Vec<(usize, ToolCallOutcome)> = Vec::new();
    let mut join_set = tokio::task::JoinSet::new();
    // `JoinError` carries no payload, so the task id is the only way back to
    // the call that panicked. Without this the failure was filed under index 0
    // and the real call got a duplicate synthesized "Skipped" result.
    let mut join_owners: std::collections::HashMap<tokio::task::Id, (usize, String, String)> =
        std::collections::HashMap::new();
    for (i, p) in prepared.into_iter().enumerate() {
        tracing::info!(task_id, tool_id = %p.tool_call.id, tool = %p.tool_call.function.name, "Tool started");
        // Hosted subagent tools route through the SubagentHost here too, so
        // the routing never depends on which batch path a call lands in.
        if is_hosted_tool(p.tool_call.function.name.as_str()) {
            let outcome =
                execute_hosted_tool(host, p, &cancel_signal, &sender, task_id, depth).await;
            results.push((i, outcome));
            continue;
        }
        let registry = Arc::clone(&tool_registry);
        let signal = cancel_signal.clone();
        let event_sender = sender.clone();
        let owner_id = p.tool_call.id.clone();
        let owner_name = p.tool_call.function.name.clone();
        let handle = join_set.spawn(async move {
            (
                i,
                execute_prepared_tool(p, &registry, &signal, &event_sender, task_id).await,
            )
        });
        join_owners.insert(handle.id(), (i, owner_id, owner_name));
    }
    while !join_set.is_empty() {
        tokio::select! {
            joined = join_set.join_next(), if !join_set.is_empty() => {
                match joined {
                    Some(Ok((i, outcome))) => results.push((i, outcome)),
                    Some(Err(e)) => {
                        let (index, owner_id, owner_name) = join_owners
                            .get(&e.id())
                            .cloned()
                            .unwrap_or_default();
                        results.push((
                            index,
                            ToolCallOutcome {
                                tool_call_id: owner_id,
                                tool_name: owner_name,
                                content: format!("Error: Task join error: {e}"),
                                is_error: true,
                                path_changed: None,
                                changed_path: None,
                                file_before: None,
                                file_after: None,
                                todos: None,
                            },
                        ));
                    }
                    None => break,
                }
            }
            _ = cancel_signal.wait_aborted() => {
                tracing::info!("Parallel tool execution cancelled while running");
                join_set.abort_all();
                break;
            }
        }
    }

    for outcome in &immediate_errors {
        finalize_tool_result(outcome, &sender, task_id);
    }

    results.sort_by_key(|(i, _)| *i);
    for (_, outcome) in &results {
        finalize_tool_result(outcome, &sender, task_id);
    }

    let mut all_outcomes = immediate_errors;
    for (_, outcome) in results {
        all_outcomes.push(outcome);
    }
    finalize_skipped_calls(tool_calls, &mut all_outcomes, &sender, task_id);
    all_outcomes
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_tool_calls_batched(
    tool_calls: &[ToolCall],
    tool_registry: Arc<ToolRegistry>,
    sender: Sender<AgentTaskEvent>,
    task_id: u64,
    permission_engine: &SharedPermissionEngine,
    broker: &ApprovalBroker,
    cancel_signal: &AbortSignal,
    project_dir: &str,
    depth: u32,
    host: Option<&SubagentHost>,
) -> Vec<ToolCallOutcome> {
    let mut outcomes = Vec::new();
    let mut parallel_batch: Vec<ToolCall> = Vec::new();

    for tool_call in tool_calls {
        if cancel_signal.is_aborted() {
            break;
        }

        if tool_registry.is_sequential(&tool_call.function.name) {
            if !parallel_batch.is_empty() {
                let batch = std::mem::take(&mut parallel_batch);
                outcomes.extend(
                    execute_tool_calls_parallel(
                        &batch,
                        Arc::clone(&tool_registry),
                        sender.clone(),
                        task_id,
                        permission_engine,
                        broker,
                        cancel_signal.clone(),
                        project_dir,
                        depth,
                        host,
                    )
                    .await,
                );
                if cancel_signal.is_aborted() {
                    break;
                }
            }

            let seq_outcomes = execute_tool_calls_sequential(
                std::slice::from_ref(tool_call),
                Arc::clone(&tool_registry),
                sender.clone(),
                task_id,
                permission_engine,
                broker,
                cancel_signal.clone(),
                project_dir,
                depth,
                host,
            )
            .await;
            let seq_failed = seq_outcomes.iter().any(|o| o.is_error);
            outcomes.extend(seq_outcomes);
            if seq_failed {
                // A sequential tool failed; drop the remaining tool calls in
                // this batch (parallel + sequential) to avoid cascading.
                tracing::info!("Sequential tool failed; dropping remaining batched calls");
                break;
            }
        } else {
            parallel_batch.push(tool_call.clone());
        }
    }

    if !parallel_batch.is_empty() {
        outcomes.extend(
            execute_tool_calls_parallel(
                &parallel_batch,
                Arc::clone(&tool_registry),
                sender.clone(),
                task_id,
                permission_engine,
                broker,
                cancel_signal.clone(),
                project_dir,
                depth,
                host,
            )
            .await,
        );
    }

    finalize_skipped_calls(tool_calls, &mut outcomes, &sender, task_id);
    outcomes
}

#[cfg(test)]
mod tests {
    use super::{execute_prepared_tool, prepare_tool_call};
    use crate::agent::channel::config::PreparedToolCall;
    use crate::cancellation::AbortSignal;
    use crate::permissions::{
        shared_permission_engine_with_config, ApprovalBroker, Permission, PermissionRule,
    };
    use crate::tools::ToolRegistry;
    use crate::types::{AgentMode, FunctionCall, ToolCall};

    fn prepared_read(args: serde_json::Value) -> PreparedToolCall {
        PreparedToolCall {
            tool_call: ToolCall {
                id: "c1".to_string(),
                call_type: "function".to_string(),
                function: FunctionCall {
                    name: "read_file".to_string(),
                    arguments: args.to_string(),
                },
            },
            args,
            file_before: None,
        }
    }

    /// A denied tool must be rejected during preparation, before any
    /// execution, even with auto-approve on and a config that would allow it.
    #[tokio::test]
    async fn explicit_deny_blocks_tool_preparation() {
        let dir = std::env::temp_dir().join(format!("agente-exec-deny-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::AutoApproveConfig {
            write_new_files: true,
            ..Default::default()
        };
        let engine =
            shared_permission_engine_with_config(AgentMode::Build, &config, dir.to_str().unwrap());
        {
            let mut engine = engine.write().unwrap();
            engine.add_rule(PermissionRule::new("tool:write_file", Permission::Deny));
            engine.set_auto_approve(true);
        }

        let registry = ToolRegistry::new(dir.to_string_lossy().to_string());
        let broker = ApprovalBroker::new();
        let (sender, _rx) = std::sync::mpsc::channel();
        let call = ToolCall {
            id: "call-1".to_string(),
            call_type: "function".to_string(),
            function: FunctionCall {
                name: "write_file".to_string(),
                arguments: serde_json::json!({"path": "x.txt", "content": "hi"}).to_string(),
            },
        };
        let outcome = match prepare_tool_call(
            &call,
            &registry,
            &engine,
            &sender,
            1,
            &broker,
            &AbortSignal::never(),
            dir.to_str().unwrap(),
        )
        .await
        {
            Err(outcome) => outcome,
            Ok(_) => panic!("deny must fail preparation"),
        };
        assert!(outcome.is_error, "{}", outcome.content);
        assert!(!dir.join("x.txt").exists(), "denied write must not run");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The model must receive the whole requested range, not a hardcoded
    /// "first 10 lines" summary. This was the bug that made `read_file`
    /// useless for any file over 30 lines.
    #[tokio::test]
    async fn read_file_results_are_not_summarized_to_ten_lines() {
        let dir = std::env::temp_dir().join(format!("agente-exec-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let body: String = (1..=50).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.join("f.txt"), body).unwrap();

        let registry = ToolRegistry::new(dir.to_string_lossy().to_string());
        let args = serde_json::json!({"path": "f.txt", "start_line": 1, "end_line": 50});
        let (sender, _rx) = std::sync::mpsc::channel();
        let outcome = execute_prepared_tool(
            prepared_read(args),
            &registry,
            &AbortSignal::never(),
            &sender,
            1,
        )
        .await;

        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("line 50"), "{}", outcome.content);
        assert!(
            !outcome.content.contains("showing first 10"),
            "read output must not be summarized: {}",
            outcome.content
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A range wider than the per-read cap must announce itself up front and
    /// hand back the exact continuation call.
    #[tokio::test]
    async fn oversized_range_read_carries_a_leading_partial_marker() {
        let dir = std::env::temp_dir().join(format!("agente-exec-cap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let body: String = (1..=2500).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.join("big.txt"), body).unwrap();

        let registry = ToolRegistry::new(dir.to_string_lossy().to_string());
        let args = serde_json::json!({"path": "big.txt", "start_line": 1, "end_line": 2500});
        let (sender, _rx) = std::sync::mpsc::channel();
        let outcome = execute_prepared_tool(
            prepared_read(args),
            &registry,
            &AbortSignal::never(),
            &sender,
            1,
        )
        .await;

        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(
            outcome.content.starts_with("[PARTIAL view"),
            "marker must be the first thing the model reads: {}",
            &outcome.content[..outcome.content.len().min(200)]
        );
        assert!(
            outcome
                .content
                .contains("next: read_file with start_line=2001"),
            "{}",
            &outcome.content[..outcome.content.len().min(400)]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
