/** Chat wire contracts. This module has no runtime dependencies. */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface RequestMessage {
  providerState?: { provider: string; blocks: Array<Record<string, unknown>> };
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  /** DeepSeek / OpenAI-compatible chain-of-thought; required when echoing tool-call turns. */
  reasoning_content?: string | null;
  attachments?: Array<{ kind?: string; base64?: string; name?: string; ocrText?: string }>;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolParameterSchema {
  type: string;
  description?: string;
  properties?: Record<string, ToolParameterSchema>;
  items?: ToolParameterSchema;
  required?: string[];
  enum?: Array<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | ToolParameterSchema;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameterSchema>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CompletionResult {
  providerState?: RequestMessage['providerState'];
  content: string;
  reasoning: string;
  toolCalls?: NativeToolCall[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    eval_count?: number;
    eval_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    timings?: {
      prompt_n?: number;
      prompt_ms?: number;
      prompt_per_second?: number;
      predicted_n?: number;
      predicted_ms?: number;
      predicted_per_second?: number;
      total_ms?: number;
    };
  } | null;
}

