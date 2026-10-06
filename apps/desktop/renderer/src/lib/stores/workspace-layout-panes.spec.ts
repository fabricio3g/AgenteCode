// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { parseWorkspaceLayout } from '$lib/components/layout/workspace-layout';
import { workspaceLayout } from './workspace-layout.svelte';

const area = { x: 0, y: 0, width: 1200, height: 800 };
const chats = () => workspaceLayout.panes.map((leaf) => leaf.chatId);

beforeEach(() => {
  workspaceLayout.selectScope('chat:panes');
  workspaceLayout.centre = null; workspaceLayout.focusedPane = '';
  workspaceLayout.restore(parseWorkspaceLayout(null));
});

describe('the centre in the layout store', () => {
  it('opens the first conversation, then swaps the focused pane', () => {
    workspaceLayout.showConversation('a');
    expect(chats()).toEqual(['a']);
    expect(workspaceLayout.centreChatId).toBe('a');

    workspaceLayout.showConversation('b');
    expect(chats()).toEqual(['b']);
    expect(workspaceLayout.centreChatId).toBe('b');
  });

  it('opens a conversation beside another and gives it the keyboard', () => {
    workspaceLayout.showConversation('a');
    expect(workspaceLayout.splitWith('b', 'right', area)).toBe(true);
    expect(chats()).toEqual(['a', 'b']);
    expect(workspaceLayout.centreChatId).toBe('b');
  });

  it('refuses a split the window cannot hold, instead of squeezing two columns', () => {
    workspaceLayout.showConversation('a');
    expect(workspaceLayout.splitWith('b', 'right', { ...area, width: 400 })).toBe(false);
    expect(chats()).toEqual(['a']);
  });

  it('focuses the pane a conversation already has instead of showing it twice', () => {
    workspaceLayout.showConversation('a');
    workspaceLayout.splitWith('b', 'right', area);
    expect(workspaceLayout.splitWith('a', 'right', area)).toBe(true);
    expect(chats()).toEqual(['a', 'b']);
    expect(workspaceLayout.centreChatId).toBe('a');
  });

  it('closes a pane, hands the keyboard to its neighbour, and keeps the last one', () => {
    workspaceLayout.showConversation('a');
    workspaceLayout.splitWith('b', 'right', area);
    const [first, second] = workspaceLayout.panes;

    expect(workspaceLayout.closePane(second.id)).toBe(true);
    expect(chats()).toEqual(['a']);
    expect(workspaceLayout.centreChatId).toBe('a');

    expect(workspaceLayout.closePane(first.id)).toBe(false);
    expect(chats()).toEqual(['a']);
  });

  it('refuses to split an already narrow pane even in a wide window', () => {
    workspaceLayout.showConversation('a'); workspaceLayout.splitWith('b', 'right', area);
    expect(workspaceLayout.splitWith('c', 'right', area)).toBe(false);
    expect(chats()).toEqual(['a', 'b']);
    expect(workspaceLayout.closePane('unknown')).toBe(false);
  });

  it('remembers which conversation is where across a reopen', () => {
    workspaceLayout.showConversation('a');
    workspaceLayout.splitWith('b', 'bottom', area);
    const saved = parseWorkspaceLayout(JSON.stringify(workspaceLayout.layouts[workspaceLayout.spaceScope]));
    workspaceLayout.centre = null; workspaceLayout.centre = saved.centre;
    expect(chats()).toEqual(['a', 'b']);
  });
});
