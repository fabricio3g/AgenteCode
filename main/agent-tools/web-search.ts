import { AgentTool } from './base.ts';
import { webSearch } from '../search-engine.ts';

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
    const response = await webSearch({
      query,
      mode: 'search',
      options: {
        max_results: max_results || 5
      }
    });
    return {
      query: response?.query || query,
      provider_used: response?.provider_used || 'none',
      results: (response?.results || []).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet
      }))
    };
  }
}
