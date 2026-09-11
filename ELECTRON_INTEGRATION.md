# Electron Native Integration Guide

This guide explains how to integrate the Rust code-agent runtime into the existing Electron local LLM chat app.

The Electron app keeps its current provider/model system. Rust keeps provider support for the TUI, but Electron should use the native binding only for heavy local agent work: workspace tools, permissions, approvals, folder-scoped execution, and file changes.

## Architecture

```text
Electron renderer
  -> Electron main process
    -> existing Electron provider/model system
    -> @agente/native AgentRuntime
      -> agente-core ToolRegistry
      -> agente-core PermissionEngine
      -> workspace file/shell/search tools
```

Do not route Electron provider requests through Rust providers. The Rust provider registry is still used by the TUI.

## Native Module

The native crate is at `crates/agente-node` and exposes `@agente/native`.

Current API:

```ts
import { AgentRuntime } from "@agente/native"

const agent = new AgentRuntime(projectDir, "plan", false)

agent.setMode("build")
agent.setAutoApprove(false)

const tools = JSON.parse(await agent.getToolDefinitionsJson("build"))
const connectedMcpServers = JSON.parse(await agent.connectMcpServersJson(JSON.stringify(mcpConfig)))
const reviews = JSON.parse(agent.reviewToolCallsJson(JSON.stringify(toolCalls)))
const results = JSON.parse(await agent.executeToolCallsJson(JSON.stringify(toolCalls)))
const approvedResults = JSON.parse(await agent.executeApprovedToolCallsJson(JSON.stringify(toolCalls)))
```

The JSON API is intentional for the first integration slice. It avoids coupling Rust to the Electron provider's internal object shape while still executing natively in-process.

## Project Folder Selection

Electron should own folder selection UI.

Recommended main-process flow:

```ts
import { dialog } from "electron"
import { AgentRuntime } from "@agente/native"

async function selectProjectFolder(win) {
  const result = await dialog.showOpenDialog(win, {
    title: "Select project folder",
    properties: ["openDirectory", "createDirectory"],
  })

  if (result.canceled || result.filePaths.length === 0) return null

  return result.filePaths[0]
}

const projectDir = await selectProjectFolder(mainWindow)
const agent = new AgentRuntime(projectDir, "plan", false)
```

When the user switches folder, create a new `AgentRuntime`. The runtime binds tools to one project directory so file operations cannot escape that workspace.

UI display suggestions:

- Show the current folder in the chat header or sidebar.
- Add a `Change project` action near model/provider controls.
- If no project is selected, disable agent tools and show `Select a project folder to enable code actions`.
- Ask before switching project while a turn is running; cancel the current turn first.

## Provider And Model Selection

Electron already owns providers and models. Keep that system as-is.

Electron responsibilities:

- Provider auth and API keys.
- Model discovery and model picker.
- Model streaming.
- Tool-call parsing from the provider response.
- Sending normalized tool definitions and tool results back into the model conversation.

Rust responsibilities:

- Return tool definitions for the active mode.
- Review tool calls for approval/denial.
- Execute approved/allowed tool calls.
- Return tool results.

Recommended turn setup:

```ts
const mode = ui.agentMode // "plan" | "build"
agent.setMode(mode)

const tools = JSON.parse(await agent.getToolDefinitionsJson(mode))

const stream = provider.streamChat({
  model: selectedModel,
  messages,
  tools,
})
```

Plan mode returns read-only tools. Build mode returns read, search, write, edit, shell, and todo tools.

## MCP Support

Electron can pass MCP server configuration to the native runtime. Rust connects the MCP servers, discovers their tools, and registers them alongside native tools.

Native API:

```ts
const connectedServers = JSON.parse(
  await agent.connectMcpServersJson(JSON.stringify({
    filesystem: {
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", projectDir],
      enabled: true,
      plan_mode: true,
    },
  }))
)

const tools = JSON.parse(await agent.getToolDefinitionsJson(mode))
```

MCP config shape:

```ts
interface McpConfig {
  type?: "local" | "remote"
  command?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  timeout?: number
  enabled?: boolean
  plan_mode?: boolean
}
```

Current support:

- Local stdio MCP servers are supported.
- Remote MCP config is accepted but the Rust transport does not implement remote calls yet.
- MCP tools are registered under sanitized names like `server_tool`.
- MCP tools are treated as parallel tools.

Recommended Electron flow:

```ts
const agent = new AgentRuntime(projectDir, "plan", false)

const connectedMcpServers = JSON.parse(
  await agent.connectMcpServersJson(JSON.stringify(appMcpConfig))
)

mainWindow.webContents.send("agent:mcp-connected", connectedMcpServers)

const tools = JSON.parse(await agent.getToolDefinitionsJson(mode))
```

UI display suggestions:

- Add an `MCP` section in settings.
- Show configured servers with connected/error state.
- Show discovered MCP tools in a collapsible `External tools` list.
- Display MCP tool calls with an external-tool icon and the full tool name.
- Ask for approval before executing MCP tools if your Electron policy treats external tools as risky.

Security notes:

- Local MCP commands execute processes on the user's machine.
- Do not auto-enable arbitrary MCP configs from untrusted project files.
- Prefer user-configured MCP servers stored in Electron settings.
- Show the command before first connection.
- Consider requiring approval for new MCP servers per project.

## Approval System

The TUI approval flow is:

- `Y`: approve once.
- `A`: approve all.
- `N` or `Esc`: deny.

Electron should use the same concepts, but with a dialog or inline approval card.

Native flow:

```ts
const toolCallsJson = JSON.stringify(toolCalls)
const reviews = JSON.parse(agent.reviewToolCallsJson(toolCallsJson))

const denied = reviews.filter((r) => r.is_denied)
const approvalNeeded = reviews.filter((r) => r.approval_required)

if (denied.length > 0) {
  // Send denied tool results back to the model or show a blocked state.
}

if (approvalNeeded.length > 0) {
  const action = await showApprovalDialog(approvalNeeded)

  if (action === "deny") {
    // Return denied/cancelled tool results to the model.
    return
  }

  if (action === "approve_all") {
    agent.setAutoApprove(true)
  }

  const results = JSON.parse(
    await agent.executeApprovedToolCallsJson(toolCallsJson)
  )
}

const results = JSON.parse(await agent.executeToolCallsJson(toolCallsJson))
```

Approval review shape:

```ts
interface ExternalToolReview {
  tool_call_id: string
  tool_name: string
  tool_args: string
  description: string
  approval_required: boolean
  is_denied: boolean
  is_dangerous: boolean
  file_path?: string
}
```

Tool result shape:

```ts
interface ExternalToolResult {
  tool_call_id: string
  tool_name: string
  content: string
  is_error: boolean
  approval_required: boolean
}
```

UI display suggestions:

- Show approval as a blocking card above the input.
- Display tool name, file path, command, and danger state.
- Use actions: `Approve once`, `Approve all`, `Deny`.
- For shell commands, show the full command in a monospace block.
- For file edits, show file path first; diff previews can be added later.

## Auto-Approve

Auto-approve means Rust permissions return `Allow` for all tools.

Use it carefully:

```ts
agent.setAutoApprove(true)
```

Recommended UI behavior:

- Keep auto-approve off by default.
- Show a visible `Auto-approve enabled` indicator.
- Make it session-scoped, not global across all projects.
- Turn it off automatically when switching project folders.
- Consider always asking for shell commands even when auto-approve is on in a later policy layer.

Recommended controls:

- Header toggle: `Auto-approve`.
- Approval dialog action: `Approve all for this session`.
- Settings description: `Allows the agent to run file and shell tools without prompting in this project.`

## Mode Handling

The runtime supports:

- `plan`: read-only analysis. No write/edit/shell tool definitions are exposed.
- `build`: full code-agent mode.

Electron should expose this as a simple mode toggle:

```ts
agent.setMode("plan")
const tools = JSON.parse(await agent.getToolDefinitionsJson("plan"))
```

Display suggestions:

- `Plan`: subtle label, read/search only.
- `Build`: stronger label, can modify files and run commands.
- If the user asks for implementation while in Plan mode, offer `Switch to Build`.

## Tool Call Loop

Minimal provider-owned loop:

```ts
async function runAgentTurn({ agent, provider, model, messages, mode }) {
  agent.setMode(mode)
  const tools = JSON.parse(await agent.getToolDefinitionsJson(mode))

  const response = await provider.chat({ model, messages, tools })
  messages.push(response.assistantMessage)

  if (!response.toolCalls?.length) return response

  const toolCallsJson = JSON.stringify(response.toolCalls)
  const reviews = JSON.parse(agent.reviewToolCallsJson(toolCallsJson))
  const approvalNeeded = reviews.filter((r) => r.approval_required)

  let results
  if (approvalNeeded.length > 0) {
    const approval = await showApprovalDialog(approvalNeeded)
    if (approval === "deny") return response
    if (approval === "approve_all") agent.setAutoApprove(true)
    results = JSON.parse(await agent.executeApprovedToolCallsJson(toolCallsJson))
  } else {
    results = JSON.parse(await agent.executeToolCallsJson(toolCallsJson))
  }

  for (const result of results) {
    messages.push({
      role: "tool",
      tool_call_id: result.tool_call_id,
      content: result.content,
    })
  }

  return runAgentTurn({ agent, provider, model, messages, mode })
}
```

Add an iteration cap, for example `50`, to prevent infinite loops.

## Renderer Event Mapping

The native binding currently returns results instead of streaming UI events. Electron should emit renderer events from the main process around native calls.

Suggested events:

```ts
mainWindow.webContents.send("agent:tool-start", {
  name: toolCall.function.name,
  args: toolCall.function.arguments,
})

mainWindow.webContents.send("agent:approval-requested", review)

mainWindow.webContents.send("agent:tool-result", result)

mainWindow.webContents.send("agent:mode-changed", mode)

mainWindow.webContents.send("agent:project-changed", projectDir)

mainWindow.webContents.send("agent:auto-approve-changed", enabled)
```

Renderer components:

- Project selector button.
- Provider/model selector from existing app.
- Plan/Build toggle.
- Auto-approve toggle.
- Tool activity list.
- Approval card/modal.
- Changed files panel.

## Diff And Revert

The native runtime tracks file changes made by `write_file` and `edit_file` tool calls. The tracker captures the original file content before the first agent edit and the latest content after successful execution.

Native API:

```ts
const changedFiles = JSON.parse(await agent.getChangedFilesJson())
const diff = JSON.parse(await agent.getFileDiffJson("src/app.ts"))
const revert = JSON.parse(await agent.revertFileJson("src/app.ts"))
const revertAll = JSON.parse(await agent.revertAllFilesJson())
```

Changed file shape:

```ts
interface ChangedFileInfo {
  path: string
  status: "Created" | "Modified" | "Deleted"
  additions: number
  deletions: number
}
```

Diff shape:

```ts
interface FileDiffInfo extends ChangedFileInfo {
  unified_diff: string
}
```

Revert result shape:

```ts
interface RevertResult {
  path: string
  reverted: boolean
  conflict: boolean
  message: string
}
```

Revert behavior:

- `Created`: deletes the created file.
- `Modified`: writes the original content back.
- `Deleted`: reserved for future delete-tool support; recreates original content when available.

Conflict behavior:

- Before reverting, Rust compares the current disk content with the tracked `after` content.
- If the file changed outside the agent after the edit, revert is refused and returns `conflict: true`.
- The UI should then show `File changed outside the agent. Review manually.`

Recommended UI:

- Show changed files in a right sidebar or collapsible bottom panel.
- Each row should show `path`, status, `+N -M`, `View diff`, and `Revert`.
- `View diff` opens a unified diff panel.
- `Revert` asks for confirmation before calling `revertFileJson(path)`.
- `Revert all` asks for confirmation before calling `revertAllFilesJson()`.

Main-process event mapping:

```ts
async function refreshChangedFiles(agent, mainWindow) {
  const files = JSON.parse(await agent.getChangedFilesJson())
  mainWindow.webContents.send("agent:changed-files-updated", files)
}

async function showFileDiff(agent, mainWindow, path) {
  const diff = JSON.parse(await agent.getFileDiffJson(path))
  mainWindow.webContents.send("agent:diff-ready", diff)
}

async function revertFile(agent, mainWindow, path) {
  const result = JSON.parse(await agent.revertFileJson(path))
  mainWindow.webContents.send("agent:revert-completed", result)
  await refreshChangedFiles(agent, mainWindow)
}
```

Call `refreshChangedFiles` after every successful tool execution.

## Current Gaps

These are not implemented in the native binding yet:

- Native streaming event callbacks.
- Native cancellation for already-running shell commands.
- File diff previews inside approval review.
- Session persistence exposed through native API.

Recommended next native API additions:

```ts
agent.cancel()
agent.setProjectDir(projectDir) // or keep creating a new runtime
agent.getStatusJson()
```

For now, create a new runtime per project and emit UI events from Electron main around each native call.
