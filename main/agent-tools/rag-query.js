import { AgentTool } from './base.js';
import { queryDocuments } from '../rag-engine.js';

export class RagQueryTool extends AgentTool {
  name = 'rag_query';
  description = 'Search RAG documents for the current chat';
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The query to search' },
      top_k: { type: 'number', description: 'Max results' }
    },
    required: ['query']
  };

  async execute({ query, top_k }, context) {
    const results = await queryDocuments({ query, chat_id: context.chatId, top_k: top_k || 5 });
    return results;
  }
}
