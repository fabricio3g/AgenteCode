import { AgentTool } from './base.js';

export class WebScrapeTool extends AgentTool {
  name = 'web_scrape';
  description = 'Scrape a URL and return text content';
  parameters = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to scrape' },
      max_length: { type: 'number', description: 'Maximum content length' }
    },
    required: ['url']
  };

  async execute({ url, max_length }) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    return { content: max_length ? text.slice(0, max_length) : text };
  }
}
