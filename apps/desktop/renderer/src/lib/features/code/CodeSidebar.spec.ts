// @vitest-environment jsdom
/**
 * The code sidebar's project folders.
 *
 * The regression: the reveal that opens the current conversation's folder ran
 * on every write to `expandedProjects`, so the folder holding the conversation
 * on screen — the one the user is most likely to close — was the one folder
 * that never closed.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, CodeProject } from '$lib/types/chat';

const projects: CodeProject[] = [
  { id: 'proj-1', rootPath: '/tmp/one', rootName: 'one', icon: null, createdAt: 1, updatedAt: 1 },
  { id: 'proj-2', rootPath: '/tmp/two', rootName: 'two', icon: null, createdAt: 2, updatedAt: 2 }
];

vi.mock('$lib/utils/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/storage')>()),
  loadCodeProjectsFromDb: async () => projects,
  saveCodeProjectToDb: async () => {},
  deleteCodeProjectFromDb: async () => {}
}));
vi.mock('$lib/services/bridge', () => ({
  invoke: async () => undefined,
  isElectron: () => false,
  listen: async () => () => {}
}));
vi.mock('$lib/services/files', () => ({
  pickWorkspaceFolder: async () => null,
  pathExists: async () => true,
  openWorkspaceFile: async () => undefined
}));

import { appStore } from '$lib/stores/app.svelte';
import { codeStore } from './code.svelte';
import CodeSidebar from './CodeSidebar.svelte';

function chat(id: string, title: string, projectId: string): ChatSession {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 1,
    folderId: null,
    draft: '',
    contextMode: 'code',
    projectId,
    messages: []
  };
}

/** The folder's hover "+": the only action inside a project row with this label. */
function addButton(view: { container: HTMLElement }): HTMLButtonElement {
  const button = view.container.querySelector<HTMLButtonElement>('.project > .sidebar-row [aria-label="New conversation"]');
  if (!button) throw new Error('the project row has no add button');
  return button;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('chatealm_app_config', JSON.stringify({ llm: { provider: 'openai', providers: { openai: { model: 'gpt-4' } } } }));
  codeStore.projects = [...projects];
  codeStore.expandedProjects = {};
  codeStore.loaded = true;
  appStore.chats = [chat('chat-1', 'Open conversation', 'proj-1'), chat('chat-2', 'Other conversation', 'proj-2')];
  appStore.currentChatId = 'chat-1';
});
afterEach(cleanup);

describe('the code sidebar tree', () => {
  it('opens the current conversation folder and closes it on a click', async () => {
    const view = render(CodeSidebar);
    await waitFor(() => expect(view.getByText('Open conversation')).toBeTruthy());

    await fireEvent.click(view.getByText('one'));

    await waitFor(() => expect(view.queryByText('Open conversation')).toBeNull());
    expect(codeStore.expandedProjects['proj-1']).toBe(false);
    // Nothing re-opens it behind the user's back.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.queryByText('Open conversation')).toBeNull();
  });

  it('reveals the folder when the current conversation moves to another project', async () => {
    const view = render(CodeSidebar);
    await waitFor(() => expect(view.getByText('Open conversation')).toBeTruthy());
    await fireEvent.click(view.getByText('one'));
    await waitFor(() => expect(view.queryByText('Open conversation')).toBeNull());

    appStore.currentChatId = 'chat-2';

    await waitFor(() => expect(view.getByText('Other conversation')).toBeTruthy());
    expect(codeStore.expandedProjects['proj-2']).toBe(true);
  });

  it('keeps the folder open when its own "+" starts a conversation', async () => {
    const view = render(CodeSidebar);
    await waitFor(() => expect(view.getByText('Open conversation')).toBeTruthy());
    const toggle = vi.spyOn(codeStore, 'toggleExpanded');

    await fireEvent.click(addButton(view));

    await waitFor(() => expect(appStore.currentChat?.projectId).toBe('proj-1'));
    // The click belongs to the "+", not to the row that toggles the folder.
    expect(toggle).not.toHaveBeenCalled();
    expect(codeStore.expandedProjects['proj-1']).toBe(true);
    expect(view.queryByText('Open conversation')).toBeTruthy();
    toggle.mockRestore();
  });
});
