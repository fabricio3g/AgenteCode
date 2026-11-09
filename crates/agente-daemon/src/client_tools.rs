//! Client-owned tools are isolated to a session and the connection that registered them.
use agente_core::mcp::{McpManager, McpTool, McpToolAdapter};
use agente_core::tools::{Tool, ToolError, ToolExecutionContext, ToolExecutionMode};
use agente_core::{permissions::Permission, types::AgentMode};
use agente_protocol::{
    ClientToolCall, ClientToolDefinition, ClientToolResult, HomeTurnPolicy, SessionId, TurnId,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

type PendingCall = (SessionId, TurnId, oneshot::Sender<ClientToolResult>);
#[derive(Default)]
pub(crate) struct ClientTools {
    definitions: Mutex<HashMap<SessionId, Vec<ClientToolDefinition>>>,
    pending: Mutex<HashMap<String, PendingCall>>,
    turns: Mutex<Vec<TurnId>>,
}
impl ClientTools {
    pub fn register(
        &self,
        session: SessionId,
        tools: Vec<ClientToolDefinition>,
    ) -> Result<(), String> {
        let mut names = std::collections::HashSet::new();
        if tools.len() > 128
            || tools.iter().any(|tool| {
                tool.name.is_empty()
                    || tool.name.starts_with(crate::complements::TOOL_PREFIX)
                    || tool.name.len() > 128
                    || !tool
                        .name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_')
                    || !names.insert(&tool.name)
                    || !tool.parameters.is_object()
            })
        {
            return Err("Invalid or duplicate client tool definitions".into());
        }
        self.definitions.lock().unwrap().insert(session, tools);
        Ok(())
    }
    pub fn tools(
        self: &Arc<Self>,
        session: SessionId,
        turn: TurnId,
        policy: &HomeTurnPolicy,
        outbox: mpsc::Sender<Value>,
        complements: Vec<(McpTool, Arc<McpManager>)>,
    ) -> Result<Vec<Box<dyn Tool>>, String> {
        let definitions = self
            .definitions
            .lock()
            .unwrap()
            .get(&session)
            .cloned()
            .ok_or("Register Home tools before starting a turn")?;
        let count = Arc::new(AtomicU32::new(0));
        self.turns.lock().unwrap().push(turn);
        Ok(definitions
            .into_iter()
            .map(|definition| (definition, None))
            .chain(complements.into_iter().map(|(tool, manager)| {
                let definition = ClientToolDefinition {
                    name: tool.full_name.clone(),
                    description: tool.description.clone(),
                    parameters: tool.input_schema.clone(),
                    mutating: !tool.read_only,
                    sequential: !tool.read_only,
                };
                (definition, Some(McpToolAdapter::from_mcp_tool(tool, manager)))
            }))
            .map(|(definition, complement)| {
                Box::new(ClientTool {
                    definition,
                    session,
                    turn,
                    bridge: Arc::clone(self),
                    outbox: outbox.clone(),
                    count: Arc::clone(&count),
                    limit: policy.max_tool_calls,
                    attachments: Mutex::new(HashMap::new()),
                    complement,
                }) as Box<dyn Tool>
            })
            .collect())
    }
    pub fn result(&self, result: ClientToolResult) -> Result<(), String> {
        let mut pending = self.pending.lock().unwrap();
        let Some((session, turn, _)) = pending.get(&result.request_id) else {
            return Err("Stale or duplicate tool result".into());
        };
        if *session != result.session_id || *turn != result.turn_id {
            return Err("Tool result belongs to another session or turn".into());
        }
        let (_, _, sender) = pending.remove(&result.request_id).unwrap();
        sender
            .send(result)
            .map_err(|_| "Tool call was cancelled".into())
    }
    pub fn disconnect(&self, runtime: &agente_runtime::RuntimeHandle) {
        for turn in self.turns.lock().unwrap().drain(..) {
            runtime.cancel(turn);
        }
        self.pending.lock().unwrap().clear();
    }
}
struct ClientTool {
    definition: ClientToolDefinition,
    session: SessionId,
    turn: TurnId,
    bridge: Arc<ClientTools>,
    outbox: mpsc::Sender<Value>,
    count: Arc<AtomicU32>,
    limit: u32,
    attachments: Mutex<HashMap<String, Vec<agente_protocol::Attachment>>>,
    complement: Option<McpToolAdapter>,
}
#[async_trait]
impl Tool for ClientTool {
    fn name(&self) -> &str {
        &self.definition.name
    }
    fn description(&self) -> &str {
        &self.definition.description
    }
    fn parameters(&self) -> Value {
        self.definition.parameters.clone()
    }
    fn execution_mode(&self) -> ToolExecutionMode {
        if self.definition.mutating || self.definition.sequential {
            ToolExecutionMode::Sequential
        } else {
            ToolExecutionMode::Parallel
        }
    }
    fn uses_host_filesystem(&self) -> bool {
        false
    }
    fn take_result_attachments(&self, call_id: &str) -> Vec<agente_protocol::Attachment> {
        if let Some(tool) = &self.complement {
            return tool.take_result_attachments(call_id);
        }
        self.attachments
            .lock()
            .unwrap()
            .remove(call_id)
            .unwrap_or_default()
    }
    fn allowed_in_plan(&self) -> bool {
        self.complement
            .as_ref()
            .map_or(!self.definition.mutating, Tool::allowed_in_plan)
    }
    fn default_permission(&self, mode: AgentMode) -> Option<Permission> {
        self.complement.as_ref()?.default_permission(mode)
    }
    async fn execute(&self, _: Value, _: &str) -> Result<String, ToolError> {
        Err(ToolError::ExecutionError(
            "Client tools require a turn context".into(),
        ))
    }
    async fn execute_with_context(
        &self,
        arguments: Value,
        project_dir: &str,
        context: ToolExecutionContext,
    ) -> Result<String, ToolError> {
        if self.count.fetch_add(1, Ordering::Relaxed) >= self.limit {
            return Err(ToolError::ExecutionError(
                "Home tool budget reached; answer from gathered evidence".into(),
            ));
        }
        if let Some(tool) = &self.complement {
            return tool.execute_with_context(arguments, project_dir, context).await;
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let call = ClientToolCall {
            session_id: self.session,
            turn_id: self.turn,
            request_id: request_id.clone(),
            call_id: context.call_id.clone(),
            name: self.definition.name.clone(),
            arguments,
        };
        let (sender, receiver) = oneshot::channel();
        self.bridge
            .pending
            .lock()
            .unwrap()
            .insert(request_id.clone(), (self.session, self.turn, sender));
        let sent = self
            .outbox
            .send(json!({"jsonrpc":"2.0","method":"client_tools.call","params":call}))
            .await;
        let result = if sent.is_err() {
            Err(ToolError::ExecutionError("Home client disconnected".into()))
        } else {
            tokio::select! {
                response = receiver => match response {
                    Ok(result) if !result.is_error => {
                        if !result.attachments.is_empty() { self.attachments.lock().unwrap().insert(context.call_id.clone(), result.attachments); }
                        Ok(result.content)
                    },
                    Ok(result) => Err(ToolError::ExecutionError(result.content)),
                    Err(_) => Err(ToolError::ExecutionError("Home client disconnected".into())),
                },
                _ = context.cancellation.wait_aborted() => {
                    let _ = self.outbox.send(json!({"jsonrpc":"2.0","method":"client_tools.cancel","params":call})).await;
                    Err(ToolError::ExecutionError("Home tool cancelled".into()))
                }
            }
        };
        self.bridge.pending.lock().unwrap().remove(&request_id);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::cancellation::AbortController;
    fn definition(name: &str) -> ClientToolDefinition {
        ClientToolDefinition {
            name: name.into(),
            description: name.into(),
            parameters: json!({"type":"object"}),
            mutating: true,
            sequential: false,
        }
    }
    #[tokio::test]
    async fn routes_only_matching_results_and_consumes_them_once() {
        let bridge = Arc::new(ClientTools::default());
        let session = SessionId::new();
        let turn = TurnId::new();
        bridge
            .register(session, vec![definition("create_document")])
            .unwrap();
        let (outbox, mut receiver) = mpsc::channel(4);
        let mut tools = bridge
            .tools(
                session,
                turn,
                &HomeTurnPolicy {
                    max_iterations: 2,
                    max_tool_calls: 1,
                    max_time_ms: 1000,
                    complements: false,
                },
                outbox,
                Vec::new(),
            )
            .unwrap();
        let tool = tools.pop().unwrap();
        assert!(!tool.uses_host_filesystem());
        assert_eq!(tool.execution_mode(), ToolExecutionMode::Sequential);
        let controller = AbortController::new();
        let mut context = ToolExecutionContext::new(controller.signal());
        context.call_id = "model-call".into();
        let task = tokio::spawn(async move {
            tool.execute_with_context(json!({"title":"Document"}), ".", context)
                .await
        });
        let call: ClientToolCall =
            serde_json::from_value(receiver.recv().await.unwrap()["params"].clone()).unwrap();
        assert_eq!(call.call_id, "model-call");
        let reply = ClientToolResult {
            session_id: session,
            turn_id: turn,
            request_id: call.request_id.clone(),
            content: "created".into(),
            is_error: false,
            attachments: Vec::new(),
        };
        let mut wrong = reply.clone();
        wrong.session_id = SessionId::new();
        assert!(bridge.result(wrong).is_err());
        bridge.result(reply.clone()).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), "created");
        assert!(bridge.result(reply).is_err());
    }
    #[tokio::test]
    async fn cancellation_rejects_late_results_and_notifies_the_owner() {
        let bridge = Arc::new(ClientTools::default());
        let session = SessionId::new();
        let turn = TurnId::new();
        bridge
            .register(session, vec![definition("create_pdf")])
            .unwrap();
        let (outbox, mut receiver) = mpsc::channel(4);
        let tool = bridge
            .tools(
                session,
                turn,
                &HomeTurnPolicy {
                    max_iterations: 2,
                    max_tool_calls: 1,
                    max_time_ms: 1000,
                    complements: false,
                },
                outbox,
                Vec::new(),
            )
            .unwrap()
            .pop()
            .unwrap();
        let controller = AbortController::new();
        let context = ToolExecutionContext::new(controller.signal());
        let task =
            tokio::spawn(async move { tool.execute_with_context(json!({}), ".", context).await });
        let call: ClientToolCall =
            serde_json::from_value(receiver.recv().await.unwrap()["params"].clone()).unwrap();
        controller.abort();
        assert!(task.await.unwrap().is_err());
        assert_eq!(
            receiver.recv().await.unwrap()["method"],
            "client_tools.cancel"
        );
        assert!(bridge
            .result(ClientToolResult {
                session_id: session,
                turn_id: turn,
                request_id: call.request_id,
                content: "late".into(),
                is_error: false,
                attachments: Vec::new()
            })
            .is_err());
    }
    #[test]
    fn manifests_are_session_scoped_and_duplicates_are_rejected() {
        let bridge = Arc::new(ClientTools::default());
        let session = SessionId::new();
        assert!(bridge
            .register(
                session,
                vec![definition("create_pdf"), definition("create_pdf")]
            )
            .is_err());
        bridge
            .register(session, vec![definition("create_pdf")])
            .unwrap();
        let (outbox, _) = mpsc::channel(1);
        assert!(bridge
            .tools(
                SessionId::new(),
                TurnId::new(),
                &HomeTurnPolicy {
                    max_iterations: 1,
                    max_tool_calls: 1,
                    max_time_ms: 1,
                    complements: false,
                },
                outbox,
                Vec::new(),
            )
            .is_err());
    }
}
