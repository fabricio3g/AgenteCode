import { expect, it } from 'vitest';
import { usedModels } from './session-metadata';
import type { ChatSession } from '$lib/types/chat';
it('reports recorded models once, including children, without inventing historical models from the selection',()=>{
  const chat={messages:[{metadata:{modelName:'model-a',codeChildren:[{model:'child-model'}]}},{metadata:{modelName:'model-b'}},{metadata:{modelName:'model-a'}}],modelSelection:{model:'selected-next'}} as unknown as ChatSession;
  expect(usedModels(chat)).toEqual(['model-a','child-model','model-b']);
});
it('leaves old conversations with missing model records unknown',()=>{expect(usedModels({messages:[],modelSelection:{model:'selected'}} as unknown as ChatSession)).toEqual([]);});
