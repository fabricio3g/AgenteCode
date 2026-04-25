import { AgentTool } from './base.ts';

export class CalculatorTool extends AgentTool {
  name = 'calculator';
  description = 'Evaluate a mathematical expression';
  parameters = {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression to evaluate' }
    },
    required: ['expression']
  };

  async execute({ expression }) {
    const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, '');
    try {
      const result = new Function(`return ${sanitized}`)();
      return { result: Number(result) };
    } catch (err) {
      return { error: `Invalid expression: ${err.message}` };
    }
  }
}
