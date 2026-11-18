// ── Effective chat template resolution ─────────────────────────────────
// llama-server renders every request through a Jinja chat template. A GGUF
// normally embeds one (`tokenizer.chat_template`), but plenty of community
// re-quants ship without it — the server then falls back to a generic
// ChatML shell with no thinking control and no tool-call parsing, so the
// model "cannot think" and tools never fire no matter what the request
// asks for.
//
// This module resolves the template the server will actually use, in
// priority order:
//   1. sidecar `<model>.chat-template.jinja` picked up from the HF repo at
//      download time (works for ANY model),
//   2. the template embedded in the GGUF,
//   3. a built-in family fallback when the family is identifiable,
//   4. none — the caller must surface that thinking/tools are unavailable.
//
// `main/providers/openai-core.ts` uses the same resolution for capability
// probing, so what the UI reports is always what rendering will do.

import fs from 'node:fs';

/** Suffix of the sidecar template file stored next to a downloaded GGUF. */
const SIDECAR_TEMPLATE_SUFFIX = '.chat-template.jinja';

/**
 * Whether a chat template grants the model a real thinking toggle. Mirrors
 * llama-ui's `detectThinkingSupport` (tools/ui/src/lib/utils/
 * chat-template-thinking-detector.ts): look for the kwargs the server
 * injects, then template-native conditionals, then paired thought tags.
 * Deliberately NOT a bare /thinking/i match — that fires on prose in
 * unrelated templates and reports support that does not exist.
 */
export function detectTemplateThinkingSupport(template: string | null | undefined): boolean {
  const t = String(template || '');
  if (!t) return false;

  for (const kwarg of ['enable_thinking', 'reasoning_effort', 'thinking_budget']) {
    if (new RegExp(`(\\{\\{[^{}]*\\b${kwarg}\\b[^{}]*\\}\\}|\\{%[^{}]*\\b${kwarg}\\b[^{}]*%\\})`, 'i').test(t)) {
      return true;
    }
  }
  const conditionals = [
    /\{%-?\s*if\s+\(?\s*\w*enable[\s_]+\w*(thinking|think|reasoning)/i,
    /\{%-?\s*if\s+\w*(thinking|reasoning)\s*(is not|==|!=)/i,
    /\{%-?\s*if\s+not\s+\w*enable/i,
    /\{%-?\s*if\s+ns\.enable_thinking/i
  ];
  if (conditionals.some((re) => re.test(t))) return true;

  const tagPairs: Array<[string, string | null]> = [
    ['<think>', '</think>'],
    ['<|channel>thought', '<|channel|>'],
    ['<|think|>', '</|think|>'],
    ['<seed:think|>', '</seed:think|>'],
    ['<think></think>', null]
  ];
  return tagPairs.some(([start, end]) => t.includes(start) && (!end || t.includes(end)));
}

/** Whether the template renders a tool-calling protocol. */
export function detectTemplateToolSupport(template: string | null | undefined): boolean {
  const t = String(template || '');
  if (!t) return false;
  return /\btools\b|\btool_calls\b|function[_\s-]?call|tool_call/i.test(t);
}

export type ModelGgufFields = {
  architecture?: string | null;
  tokenizer_model?: string | null;
  /** `tokenizer.ggml.pre` — llama.cpp's pre-tokenizer id (e.g. "minicpm5"). */
  tokenizer_pre?: string | null;
  /** `general.basename` — the model family name (e.g. "MiniCPM5"). */
  general_basename?: string | null;
  /** `general.name` — the full model title. */
  general_name?: string | null;
  chat_template?: string | null;
  /** True when the GGUF carries a `tokenizer.chat_template` key at all. */
  chat_template_present?: boolean;
} | null;

export type EffectiveTemplate = {
  template: string | null;
  source: 'sidecar' | 'gguf' | 'builtin' | 'none';
  /** Family id when the builtin fallback matched. */
  family: string | null;
};

/**
 * MiniCPM5's template (thinking via `enable_thinking`, `<think>` reasoning
 * tags, tool-call rendering). Applied when a MiniCPM5 GGUF lost its
 * embedded template, as imatrix re-quants sometimes do. Kept byte-faithful
 * to the upstream model card so multi-turn rendering matches training.
 */
export const MINICPM5_TEMPLATE = `{{- bos_token }}{%- if tools %}
    {%- set tool_definitions %}
        {{- "# Tools\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>" }}
        {%- for tool in tools %}
            {{- "\n" }}
            {{- tool | tojson(ensure_ascii=False) }}
        {%- endfor %}
        {{- '\n</tools>\n\nTool usage guidelines:\n- You may call zero or more functions. If no function calls are needed, just answer normally and do not include any <function ... </function>.\n- When calling a function, return an XML object within <function ... </function> using:\n<function name="function-name"><param name="param-name">param-value</param></function>\n- param-value may be multi-line. If it contains <, & or newline characters, wrap it in a CDATA block: <param name="param-name"><![CDATA[...multi-line value...]]></param>' }}
    {%- endset %}
    
    {{- '<|im_start|>system\n' }}
    {%- if messages[0].role == 'system' %}
        {%- if '<tool_def_sep>' in messages[0].content %}
            {{- messages[0].content.replace('<tool_def_sep>', tool_definitions) }}
        {%- else %}
            {{- messages[0].content + '\n\n' + tool_definitions }}
        {%- endif %}
    {%- else %}
        {{- tool_definitions.lstrip() }}
    {%- endif %}
    {{- '<|im_end|>\n' }}
{%- else %}
    {%- if messages[0].role == 'system' %}
        {{- '<|im_start|>system\n' + messages[0].content + '<|im_end|>\n' }}
    {%- endif %}
{%- endif %}
{%- set ns = namespace(multi_step_tool=true, last_query_index=messages|length - 1) %}
{%- for message in messages[::-1] %}
    {%- set index = (messages|length - 1) - loop.index0 %}
    {%- if ns.multi_step_tool and message.role == "user" and message.content is string and not(message.content.startswith('<tool_response>') and message.content.endswith('</tool_response>')) %}
        {%- set ns.multi_step_tool = false %}
        {%- set ns.last_query_index = index %}
    {%- endif %}
{%- endfor %}
{%- for message in messages %}
    {%- if message.content is string %}
        {%- set content = message.content %}
    {%- else %}
        {%- set content = '' %}
    {%- endif %}
    {%- if (message.role == "user") or (message.role == "system" and not loop.first) %}
        {{- '<|im_start|>' + message.role + '\n' + content + '<|im_end|>' + '\n' }}
    {%- elif message.role == "assistant" %}
        {%- set reasoning_content = '' %}
        {%- if message.reasoning_content is string %}
            {%- set reasoning_content = message.reasoning_content %}
        {%- else %}
            {%- if '</think>' in content %}
                {%- set reasoning_content = content.split('</think>')[0].rstrip('\n').split('<think>')[-1].lstrip('\n') %}
                {%- set content = content.split('</think>')[-1].lstrip('\n') %}
            {%- endif %}
        {%- endif %}
        
        {%- if message.tool_calls %}
            {%- set content_parts = content.split('<tool_sep>') %}
            {%- set processed_content = content_parts[0] %}
            {%- set tool_calls_count = message.tool_calls|length %}
            {%- set tool_sep_count = content_parts|length - 1 %}
            {%- set min_count = [tool_calls_count, tool_sep_count]|min %}
            
            {%- for i in range(1, content_parts|length) %}
                {%- set tool_index = i - 1 %}
                {%- if tool_index < tool_calls_count %}
                    {%- set tool_call = message.tool_calls[tool_index] %}
                    {%- if tool_call.function %}
                        {%- set tool_call = tool_call.function %}
                    {%- endif %}
                    {%- set single_tool_xml %}
                        {{- '<function name="' ~ tool_call.name ~ '">' }}
                        {%- if tool_call.arguments %}
                            {%- set args_dict = tool_call.arguments %}
                            {%- for param_name, param_value in args_dict.items() %}
                                {{- '<param name="' ~ param_name ~ '">' }}
                                {%- if param_value is string and ('<' in param_value or '&' in param_value or '\n' in param_value) %}
                                    {{- '<![CDATA[' + param_value + ']]>' }}
                                {%- else %}
                                    {{- param_value }}
                                {%- endif %}
                                {{- '</param>' }}
                            {%- endfor %}
                        {%- endif %}
                        {{- '</function>' }}
                    {%- endset %}
                    {%- set processed_content = processed_content + single_tool_xml + content_parts[i] %}
                {%- else %}
                    {%- set processed_content = processed_content + content_parts[i] %}
                {%- endif %}
            {%- endfor %}
            
            {%- if tool_calls_count > tool_sep_count %}
                {%- for remaining_index in range(tool_sep_count, tool_calls_count) %}
                    {%- set tool_call = message.tool_calls[remaining_index] %}
                    {%- if tool_call.function %}
                        {%- set tool_call = tool_call.function %}
                    {%- endif %}
                    {%- set remaining_tool_xml %}
                        {{- '<function name="' ~ tool_call.name ~ '">' }}
                        {%- if tool_call.arguments %}
                            {%- set args_dict = tool_call.arguments %}
                            {%- for param_name, param_value in args_dict.items() %}
                                {{- '<param name="' ~ param_name ~ '">' }}
                                {%- if param_value is string and ('<' in param_value or '&' in param_value or '\n' in param_value) %}
                                    {{- '<![CDATA[' + param_value + ']]>' }}
                                {%- else %}
                                    {{- param_value }}
                                {%- endif %}
                                {{- '</param>' }}
                            {%- endfor %}
                        {%- endif %}
                        {{- '</function>' }}
                    {%- endset %}
                    {%- set processed_content = processed_content + remaining_tool_xml %}
                {%- endfor %}
            {%- endif %}
            
            {%- set content = processed_content %}
        {%- endif %}
        
        {%- if loop.index0 > ns.last_query_index %}
            {%- if reasoning_content %}
                {{- '<|im_start|>' + message.role + '\n<think>\n' + reasoning_content.strip('\n') + '\n</think>\n\n' + content.lstrip('\n') }}
            {%- else %}
                {{- '<|im_start|>' + message.role + '\n' + content }}
            {%- endif %}
        {%- else %}
            {{- '<|im_start|>' + message.role + '\n' + content }}
        {%- endif %}
        
        {%- if message.tool_calls and not has_tool_sep %}
            {%- for tool_call in message.tool_calls %}
                {%- if (loop.first and content) or (not loop.first) %}
                    {{- '\n' }}
                {%- endif %}
                {%- if tool_call.function %}
                    {%- set tool_call = tool_call.function %}
                {%- endif %}
                {{- '<function name="' ~ tool_call.name ~ '">' }}
                {%- if tool_call.arguments %}
                    {%- set args_dict = tool_call.arguments %}
                    {%- for param_name, param_value in args_dict.items() %}
                        {{- '<param name="' ~ param_name ~ '">' }}
                        {%- if param_value is string and ('<' in param_value or '&' in param_value or '\n' in param_value) %}
                            {{- '<![CDATA[' + param_value + ']]>' }}
                        {%- else %}
                            {{- param_value }}
                        {%- endif %}
                        {{- '</param>' }}
                    {%- endfor %}
                {%- endif %}
                {{- '</function>' }}
            {%- endfor %}
        {%- endif %}
        {{- '<|im_end|>\n' }}
    {%- elif message.role == "tool" %}
        {%- if loop.first or (messages[loop.index0 - 1].role != "tool") %}
            {{- '<|im_start|>user' }}
        {%- endif %}
        {{- '\n<tool_response>\n' }}
        {%- if message.content is string %}
            {{- content }}
        {%- else %}
            {{- message.content | tojson(ensure_ascii=False) }}
        {%- endif %}
        {{- '\n</tool_response>' }}
        {%- if loop.last or (messages[loop.index0 + 1].role != "tool") %}
            {{- '<|im_end|>\n' }}
        {%- endif %}
    {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
    {{- '<|im_start|>assistant\n' }}
    {%- if enable_thinking is defined %}
        {%- if enable_thinking is false %}
            {{- '<think>\n\n</think>\n\n' }}
        {%- elif enable_thinking is true %}
            {{- '<think>\n' }}
        {%- endif %}
    {%- endif %}
{%- endif %}
`;

/**
 * Template identifiers keyed the way llama.cpp identifies families: the
 * GGUF's own `general.basename` / `tokenizer.ggml.pre` first (they travel
 * with the file), then `general.name` and the filename for older exports.
 * Matching is done on one lowercase haystack so a template-less re-quant
 * still resolves by name.
 */
const FAMILY_SIGNATURES: Array<{ family: string; pattern: RegExp }> = [
  { family: 'minicpm5', pattern: /minicpm5/ },
  { family: 'minicpm', pattern: /minicpm/ }
];

/**
 * Identify the model family from the metadata a GGUF actually exposes.
 * Priority mirrors llama.cpp's own detection: pre-tokenizer id, then base
 * name, then the general name / filename.
 */
export function detectModelFamily(fields: ModelGgufFields, filePath?: string): string | null {
  const name = String(filePath || '').split('/').pop() || '';
  const haystack = [
    fields?.tokenizer_pre,
    fields?.general_basename,
    fields?.general_name,
    fields?.architecture,
    fields?.tokenizer_model,
    name
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  for (const { family, pattern } of FAMILY_SIGNATURES) {
    if (pattern.test(haystack)) return family;
  }
  return null;
}

/** Templates whose family has a byte-faithful built-in fallback. */
const BUILTIN_TEMPLATES: Record<string, string> = {
  minicpm5: MINICPM5_TEMPLATE,
  minicpm: MINICPM5_TEMPLATE
};

/**
 * Generic ChatML with thinking and tool-call rendering. Used when a file is
 * template-less but its vocabulary proves it speaks ChatML (`<|im_start|>`
 * plus `<think>`), which is what MiniCPM/Qwen-style fine-tunes of this shape
 * are trained on. Rendering only covers tokens the model already owns, so it
 * is safe for unknown-but-matching checkpoints.
 */
export const GENERIC_CHATML_THINKING_TEMPLATE = `{%- for message in messages -%}
    {%- if message.role == 'assistant' and message.tool_calls -%}
        {{- '<|im_start|>assistant\\n' -}}
        {%- for tool in message.tool_calls -%}
            {{- '<tool_call>\\n{"name": "' + tool.function.name + '", "arguments": ' + (tool.function.arguments if tool.function.arguments is string else tool.function.arguments | tojson) + '}\\n</tool_call>\\n' -}}
        {%- endfor -%}
        {{- '<|im_end|>\\n' -}}
    {%- elif message.role == 'assistant' -%}
        {%- set content = message.content if message.content is string else '' -%}
        {%- if message.reasoning_content is defined and message.reasoning_content -%}
            {{- '<|im_start|>assistant\\n<think>\\n' + message.reasoning_content + '\\n</think>\\n\\n' + content + '<|im_end|>\\n' -}}
        {%- else -%}
            {{- '<|im_start|>assistant\\n' + content + '<|im_end|>\\n' -}}
        {%- endif -%}
    {%- elif message.role == 'tool' -%}
        {{- '<|im_start|>user\\n<tool_response>\\n' + message.content + '\\n</tool_response><|im_end|>\\n' -}}
    {%- else -%}
        {{- '<|im_start|>' + message.role + '\\n' + message.content + '<|im_end|>\\n' -}}
    {%- endif -%}
{%- endfor -%}
{%- if tools -%}
    {{- '<|im_start|>system\\n# Tools\\n\\nYou have access to the following functions:\\n\\n' -}}
    {%- for tool in tools -%}
        {{- tool | tojson + '\\n' -}}
    {%- endfor -%}
    {{- '\\nIf you choose to call a function ONLY reply in the following format:\\n\\n<tool_call>\\n{"name": <function-name>, "arguments": <args-json-object>}\\n</tool_call><|im_end|>\\n' -}}
{%- endif -%}
{%- if add_generation_prompt -%}
    {{- '<|im_start|>assistant\\n' -}}
    {%- if enable_thinking is defined and enable_thinking is false -%}
        {{- '<think>\\n\\n</think>\\n\\n' -}}
    {%- elif enable_thinking is defined and enable_thinking is true -%}
        {{- '<think>\\n' -}}
    {%- endif -%}
{%- endif -%}
`;

/**
 * Token-level inference for files whose family is not in the table. This is
 * the generic path: if the GGUF's own vocabulary proves ChatML + thinking
 * tokens, the generic template is valid for it regardless of brand.
 */
export function inferTemplateFromTokens(options: {
  hasImStart: boolean;
  hasThink: boolean;
  hasToolCall: boolean;
  architecture?: string | null;
}): { template: string; family: string } | null {
  const arch = String(options.architecture || '').toLowerCase();
  const chatmlLike = options.hasImStart || arch === 'qwen2' || arch === 'qwen3';
  if (!chatmlLike) return null;
  // Thinking tokens are the only extra capability we render; without them a
  // ChatML template cannot enable/disable thinking meaningfully.
  if (!options.hasThink) return null;
  return { template: GENERIC_CHATML_THINKING_TEMPLATE, family: 'generic-chatml-thinking' };
}

/** Sidecar path for a model file: `<model>.chat-template.jinja` next to it. */
export function sidecarTemplatePath(modelPath: string): string {
  return `${modelPath}${SIDECAR_TEMPLATE_SUFFIX}`;
}

function readFileSafe(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Chat tokens the file's tokenizer declares. Scanned from the GGUF header /
 * vocabulary region (never from quantized weights — token ids are lossy
 * binary there, so a false positive cannot round-trip to this text). Mirrors
 * llama-ui's `checkModelSupportsThinking` idea: decide from tokens the model
 * demonstrably owns, not from its brand.
 */
export function probeGgufChatTokens(modelPath: string): {
  hasImStart: boolean;
  hasThink: boolean;
  hasToolCall: boolean;
} {
  const empty = { hasImStart: false, hasThink: false, hasToolCall: false };
  try {
    const size = fs.statSync(modelPath).size;
    const readBytes = Math.min(size, 80 * 1024 * 1024);
    const fd = fs.openSync(modelPath, 'r');
    const buf = Buffer.alloc(readBytes);
    try {
      fs.readSync(fd, buf, 0, readBytes, 0);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString('utf8');
    return {
      hasImStart: text.includes('<|im_start|>'),
      hasThink: text.includes('<think>'),
      hasToolCall: text.includes('<tool_call>')
    };
  } catch {
    return empty;
  }
}

/**
 * What the server will render with, and where it came from. `ggufTemplate`
 * comes from `readGgufMetadataFields` (already parsed once per file), so a
 * missing embedded template is not re-read here.
 */
export function resolveEffectiveTemplate(options: {
  modelPath: string;
  fields?: ModelGgufFields;
  ggufTemplate?: string | null;
  /** Skip the token probe when the caller already knows the vocabulary. */
  tokens?: { hasImStart: boolean; hasThink: boolean; hasToolCall: boolean };
}): EffectiveTemplate {
  const sidecar = readFileSafe(sidecarTemplatePath(options.modelPath));
  if (sidecar) return { template: sidecar, source: 'sidecar', family: null };

  const embedded = options.ggufTemplate ?? options.fields?.chat_template ?? null;
  if (embedded) return { template: embedded, source: 'gguf', family: null };

  const family = detectModelFamily(options.fields ?? null, options.modelPath);
  const builtin = family ? BUILTIN_TEMPLATES[family] ?? null : null;
  if (builtin) return { template: builtin, source: 'builtin', family };

  const tokens = options.tokens ?? probeGgufChatTokens(options.modelPath);
  const inferred = inferTemplateFromTokens({
    ...tokens,
    architecture: options.fields?.architecture ?? null
  });
  if (inferred) return { template: inferred.template, source: 'builtin', family: inferred.family };

  return { template: null, source: 'none', family: null };
}
