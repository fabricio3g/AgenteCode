import { randomUUID } from 'node:crypto';
import { resolveProvider } from './providers/registry.ts';
import { resolveApiKey } from './chat-ipc.ts';
import { loadConfig } from './config.ts';

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
    if (!realKey && provider.name !== 'local') throw new Error('No API key configured');

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

      let result;
      try {
        result = await provider.completeChat({
          apiKey: realKey,
          baseUrl,
          model: config.model,
          messages,
          tools: toolDefs,
        });
      } catch (err) {
        const errorMsg = err?.message || String(err);

        // Check if error is due to tool not being supported
        if (errorMsg.includes('tool use') || errorMsg.includes('function calling') || errorMsg.includes('404')) {
          console.warn('[AgentRunner] Tools not supported by this provider/model, falling back to regular chat');

          try {
            const fallbackResult = await provider.completeChat({
              apiKey: realKey,
              baseUrl,
              model: config.model,
              messages,
            });

            thinkStep.status = 'done';
            thinkStep.detail = 'Tools not supported, fell back to regular chat';
            emitSteps();
            return {
              content: fallbackResult.content,
              steps: agentSteps,
              warning: 'Tools not supported by this provider. Agent mode ran without tools.'
            };
          } catch (fallbackErr) {
            thinkStep.status = 'error';
            thinkStep.label = 'Error';
            thinkStep.detail = fallbackErr?.message || String(fallbackErr);
            emitSteps();
            throw fallbackErr;
          }
        }

        thinkStep.status = 'error';
        thinkStep.label = 'Error';
        thinkStep.detail = errorMsg;
        emitSteps();
        throw err;
      }

      if (!result.toolCalls?.length) {
        thinkStep.status = 'done';
        thinkStep.detail = 'Producing answer';
        emitSteps();
        return { content: result.content, steps: agentSteps };
      }

      thinkStep.status = 'done';
      thinkStep.detail = `Using tools: ${result.toolCalls.map(tc => tc.name).join(', ')}`;
      emitSteps();

      for (const toolCall of result.toolCalls) {
        const toolStep = {
          id: randomUUID(),
          type: mapToolToStepType(toolCall.name),
          label: toolCall.name.replace(/_/g, ' '),
          status: 'running',
          detail: undefined,
        };
        agentSteps.push(toolStep);
        emitSteps();

        const tool = toolMap.get(toolCall.name);
        let toolResult;
        try {
          toolResult = tool
            ? await tool.execute(
                typeof toolCall.arguments === 'string'
                  ? JSON.parse(toolCall.arguments)
                  : toolCall.arguments,
                { chatId }
              )
            : { error: `Unknown tool: ${toolCall.name}` };
          toolStep.status = 'done';
        } catch (err) {
          toolResult = { error: err?.message || String(err) };
          toolStep.status = 'error';
          toolStep.detail = toolResult.error;
        }

        if (toolResult.error) {
          toolStep.detail = toolStep.detail || String(toolResult.error).slice(0, 200);
        }

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });
        emitSteps();
      }
    }

    return { content: 'Agent loop exceeded maximum iterations', steps: agentSteps };
  }
}
