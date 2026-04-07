import { AgentTool } from './base.js';
import { sandboxExec } from '../sandbox.js';

export class CodeExecTool extends AgentTool {
  name = 'code_exec';
  description = 'Execute code in a sandbox';
  parameters = {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Code to execute' },
      language: { type: 'string', enum: ['javascript', 'python'], default: 'javascript' }
    },
    required: ['code']
  };

  async execute({ code, language }) {
    try {
      const result = await sandboxExec({
        projectName: 'agent-tools',
        files: [],
        command: language === 'python' ? `python3 -c "${code}"` : `node -e "${code}"`,
        timeoutMs: 10000,
      });
      return { output: result?.stdout || '', error: result?.stderr || '' };
    } catch (err) {
      return { error: err.message };
    }
  }
}
