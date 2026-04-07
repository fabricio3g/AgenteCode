import { randomUUID } from 'node:crypto';
import { resolveProvider } from './providers/registry.js';
import { resolveApiKey } from './chat-ipc.js';
import { completeChatRequest } from './chat-ipc.js';
import { loadConfig } from './config.js';

function mapToolToStepType(toolName) {
  const map = {
    web_search: 'searching', fetch_url: 'searching',
    browser_navigate: 'searching', browser_snapshot: 'reading',
    browser_click: 'searching', browser_type: 'writing',
    query_knowledge: 'reading',
    read_file: 'reading', list_files: 'reading', search_files: 'reading',
    write_file: 'writing', delete_file: 'writing', move_file: 'writing',
    apply_patch: 'coding', run_code: 'executing', execute_command: 'executing',
    preview_project: 'preview', create_report: 'writing',
  };
  return map[toolName] || 'tool';
}

export class AgentRunner {
  constructor() {
    this.tools = [];
    this.enabledTools = new Map();
    this.maxIterations = 15;
  }

  async listTools() {
    return this.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      enabled: this.enabledTools.has(t.name),
    }));
  }

  async toggleTool(toolName, enabled) {
    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) throw new Error(`Tool "${toolName}" not found`);
    if (enabled) {
      this.enabledTools.set(toolName, true);
    } else {
      this.enabledTools.delete(toolName);
    }
  }

  async runAgentLoop({ chatId, messages, tools, providerName, baseUrl, apiKey, config, onStep }) {
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    if (!realKey) throw new Error('No API key configured');

    const toolMap = new Map(tools.map(t => [t.name, t]));
    const toolDefs = tools.map(t => t.toDefinition());
    const agentSteps = [];
    let maxIterations = this.maxIterations;

    const emitSteps = () => { if (onStep) onStep([...agentSteps]); };

    while (maxIterations-- > 0) {
      // Push a "thinking" step at start of each iteration
      const thinkStep = {
        id: randomUUID(),
        type: 'thinking',
        label: maxIterations === this.maxIterations - 1 ? 'Planning' : 'Thinking',
        status: 'running',
        detail: `Iteration ${this.maxIterations - maxIterations} of ${this.maxIterations}`,
      };
      agentSteps.push(thinkStep);
      emitSteps();

      const requestBody = provider.transformBody({
        model: config.model,
        messages,
        stream: false,
        tools: toolDefs,
      });

      const url = provider.resolveUrl(baseUrl);
      const headers = provider.buildHeaders(realKey);

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(120000),
        });
      } catch (err) {
        thinkStep.status = 'error';
        thinkStep.label = 'Error';
        thinkStep.detail = err?.message || String(err);
        emitSteps();
        throw err;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');

        // Check if error is due to tool not being supported
        if (errorText.includes('tool use') || errorText.includes('function calling') || response.status === 404) {
          console.warn('[AgentRunner] Tools not supported by this provider/model, falling back to regular chat');
          // Retry without tools
          const fallbackBody = provider.transformBody({
            model: config.model,
            messages,
            stream: false,
          });

          const fallbackResponse = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(fallbackBody),
            signal: AbortSignal.timeout(120000),
          });

          if (!fallbackResponse.ok) {
            throw new Error(`HTTP ${fallbackResponse.status}: ${await fallbackResponse.text().catch(() => 'Request failed')}`);
          }

          const fallbackData = await fallbackResponse.json();
          const content = fallbackData?.choices?.[0]?.message?.content || '';
          thinkStep.status = 'done';
          thinkStep.detail = 'Tools not supported, fell back to regular chat';
          emitSteps();
          return { content, steps: agentSteps, warning: 'Tools not supported by this provider. Agent mode ran without tools.' };
        }

        thinkStep.status = 'error';
        thinkStep.label = 'Error';
        thinkStep.detail = `HTTP ${response.status}: ${errorText}`;
        emitSteps();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      const toolCalls = data?.choices?.[0]?.message?.tool_calls;
      if (!toolCalls?.length) {
        const content = data?.choices?.[0]?.message?.content || '';
        thinkStep.status = 'done';
        thinkStep.detail = 'Producing answer';
        emitSteps();
        return { content, steps: agentSteps };
      }

      thinkStep.status = 'done';
      thinkStep.detail = `Using tools: ${toolCalls.map(tc => tc.function.name).join(', ')}`;
      emitSteps();

      for (const toolCall of toolCalls) {
        // Push a tool step before each execution
        const toolStep = {
          id: randomUUID(),
          type: mapToolToStepType(toolCall.function.name),
          label: toolCall.function.name.replace(/_/g, ' '),
          status: 'running',
          detail: undefined,
        };
        agentSteps.push(toolStep);
        emitSteps();

        const tool = toolMap.get(toolCall.function.name);
        let result;
        try {
          result = tool
            ? await tool.execute(JSON.parse(toolCall.function.arguments), { chatId })
            : { error: `Unknown tool: ${toolCall.function.name}` };
          toolStep.status = 'done';
        } catch (err) {
          result = { error: err?.message || String(err) };
          toolStep.status = 'error';
          toolStep.detail = result.error;
        }

        if (result.error) {
          toolStep.detail = toolStep.detail || String(result.error).slice(0, 200);
        }

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
        emitSteps();
      }
    }

    return { content: 'Agent loop exceeded maximum iterations', steps: agentSteps };
  }
}
