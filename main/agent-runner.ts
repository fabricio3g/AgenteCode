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
          tool_choice: 'auto',
        });
      } catch (err) {
        const errorMsg = err?.message || String(err);

        // Groq-specific: if model called a tool but tool_choice was none, retry with auto
        if (errorMsg.includes('Tool choice is none') || errorMsg.includes('tool_use_failed')) {
          console.warn('[AgentRunner] Groq tool_choice error, retrying with tool_choice=auto');
          try {
            result = await provider.completeChat({
              apiKey: realKey,
              baseUrl,
              model: config.model,
              messages,
              tools: toolDefs,
              tool_choice: 'auto',
            });
          } catch (retryErr) {
            const retryMsg = retryErr?.message || String(retryErr);
            if (retryMsg.includes('Tool choice is none') || retryMsg.includes('tool_use_failed')) {
              thinkStep.status = 'error';
              thinkStep.label = 'Tool Error';
              thinkStep.detail = 'Model called a tool but tool_choice constraint failed';
              emitSteps();
              
              // Try one more time WITHOUT tools to get a final answer
              try {
                const noToolResult = await provider.completeChat({
                  apiKey: realKey,
                  baseUrl,
                  model: config.model,
                  messages,
                });
                thinkStep.status = 'done';
                thinkStep.detail = 'Fell back to no-tool mode for final answer';
                emitSteps();
                return {
                  content: noToolResult.content,
                  steps: agentSteps,
                  warning: 'Agent encountered a tool error but recovered with a regular response.'
                };
              } catch (finalErr) {
                thinkStep.status = 'error';
                thinkStep.label = 'Error';
                thinkStep.detail = finalErr?.message || String(finalErr);
                emitSteps();
                throw finalErr;
              }
            }
            throw retryErr;
          }
        }
        // Check if error is due to tool not being supported
        else if (errorMsg.includes('tool use') || errorMsg.includes('function calling') || errorMsg.includes('404')) {
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

    // Max iterations reached - try one final call without tools to get an answer
    const finalStep = {
      id: randomUUID(),
      type: 'done',
      label: 'Finalizing',
      status: 'running',
      detail: 'Max iterations reached, getting final answer',
    };
    agentSteps.push(finalStep);
    emitSteps();

    try {
      const finalResult = await provider.completeChat({
        apiKey: realKey,
        baseUrl,
        model: config.model,
        messages,
      });
      finalStep.status = 'done';
      finalStep.detail = 'Final answer ready';
      emitSteps();
      return { content: finalResult.content, steps: agentSteps };
    } catch (finalErr) {
      finalStep.status = 'error';
      finalStep.label = 'Error';
      finalStep.detail = 'Max iterations reached';
      emitSteps();
      return { content: '', steps: agentSteps, error: 'Agent loop exceeded maximum iterations' };
    }
  }
}
