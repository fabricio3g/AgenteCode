export type AgentMode = "plan" | "build";

export interface ToolCall {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ExternalToolResult {
  tool_call_id: string;
  tool_name: string;
  content: string;
  is_error: boolean;
  approval_required: boolean;
}

export interface ExternalToolReview {
  tool_call_id: string;
  tool_name: string;
  tool_args: string;
  description: string;
  approval_required: boolean;
  is_denied: boolean;
  is_dangerous: boolean;
  file_path?: string;
}

export type FileChangeStatus = "Created" | "Modified" | "Deleted";

export interface ChangedFileInfo {
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
}

export interface FileDiffInfo extends ChangedFileInfo {
  unified_diff: string;
}

export interface RevertResult {
  path: string;
  reverted: boolean;
  conflict: boolean;
  message: string;
}

export interface McpConfig {
  type?: "local" | "remote";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeout?: number;
  enabled?: boolean;
  plan_mode?: boolean;
}

export class AgentRuntime {
  constructor(projectDir: string, mode?: AgentMode, autoApprove?: boolean);
  setMode(mode: AgentMode): void;
  setAutoApprove(autoApprove: boolean): void;
  getToolDefinitionsJson(mode?: AgentMode): Promise<string>;
  connectMcpServersJson(mcpConfigJson: string): Promise<string>;
  reviewToolCallsJson(toolCallsJson: string): string;
  executeToolCallsJson(toolCallsJson: string): Promise<string>;
  executeApprovedToolCallsJson(toolCallsJson: string): Promise<string>;
  getChangedFilesJson(): Promise<string>;
  getFileDiffJson(path: string): Promise<string>;
  revertFileJson(path: string): Promise<string>;
  revertAllFilesJson(): Promise<string>;
}
