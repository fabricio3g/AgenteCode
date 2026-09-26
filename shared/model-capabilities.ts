// Model capability guesses from the model id, shared by the renderer (Home
// attachments) and the main process (Code agent screenshots). Local models are
// judged by their vision projector instead (see callers).

const VISION_MODEL = new RegExp(
  [
    '\\b(vl|vision|llava|multimodal|pixtral|minicpm-?v|moondream|internvl)\\b',
    'gemma[\\s-]?[34]',
    'qwen[\\s-]?(2\\.5|3)?[\\s._-]?vl',
    'qwen[\\s-]?3[\\s._-]?[0-9]',
    'llama[\\s-]?4',
    'mistral[\\s-]?(small|medium)[\\s-]?3',
    'gpt-4o|gpt-4\\.1|gpt-5|\\bo[34](-mini)?\\b',
    'gemini',
    'claude-3|claude-(sonnet|opus|haiku)-[4-9]|claude-[4-9]',
    'grok-(2-vision|4)',
    'glm-4(\\.\\d)?v'
  ].join('|'),
  'i'
);

export function isVisionModel(modelName: string): boolean {
  return VISION_MODEL.test(modelName);
}
