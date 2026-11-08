// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import type { ChatSession } from '$lib/types/chat';
import TasksPanel from './TasksPanel.svelte';

afterEach(cleanup);

it('shows truthful progress without counting cancelled work as completed', () => {
  const chat: ChatSession = {
    id: 'tasks', title: 'Code conversation', contextMode: 'code', createdAt: 1, updatedAt: 1, folderId: null, draft: '',
    messages: [{
      id: 'reply', role: 'assistant', content: '', createdAt: 1,
      metadata: { codeTodos: [
        { content: 'Done', status: 'completed' },
        { content: 'Next', status: 'pending' },
        { content: 'Superseded', status: 'cancelled' }
      ] }
    }]
  };
  const view = render(TasksPanel, { chat });
  expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  expect(view.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('2');
  expect(view.getByText('Superseded').closest('li')?.getAttribute('title')).toBe('Cancelled');
});
