/**
 * Base class for all agent tools.
 *
 * Subclass this and override `execute()`.
 * The `parameters` field must be a valid JSON Schema object describing the
 * arguments the tool accepts (used for function-calling / tool-use payloads).
 */
export class AgentTool {
  /** @type {string} Machine-readable identifier used in tool-call payloads */
  name = 'unknown';

  /** @type {string} Human-readable description sent to the LLM */
  description = '';

  /**
   * @type {object} JSON Schema describing the tool's input parameters.
   * Example:
   * {
   *   type: 'object',
   *   properties: {
   *     code: { type: 'string', description: 'Source code to execute' }
   *   },
   *   required: ['code']
   * }
   */
  parameters = {};

  /**
   * Run the tool.
   *
   * @param {object} args – Parsed arguments matching `parameters` schema.
   * @param {AbortSignal} [signal] – Optional cancellation signal.
   * @returns {Promise<any>} Tool result that will be serialised back to the LLM.
   */
  async execute(args, signal) { // eslint-disable-line no-unused-vars
    throw new Error(`Tool "${this.name}" does not implement execute()`);
  }

  /**
   * Build the OpenAI-style tool definition object.
   * @returns {{ type: 'function', function: { name: string, description: string, parameters: object } }}
   */
  toDefinition() {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters
      }
    };
  }
}
