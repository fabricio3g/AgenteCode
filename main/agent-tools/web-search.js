import { AgentTool } from './base.js';
import { webSearch } from '../search-engine.js';

export class WebSearchTool extends AgentTool {
  name = 'web_search';
  description = 'Search the web using the configured search provider';
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      max_results: { type: 'number', description: 'Maximum number of results' }
    },
    required: ['query']
  };

  async execute({ query, max_results }) {
    const results = await webSearch({ query, maxResults: max_results || 5 });
    return (results || []).map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
  }
}
