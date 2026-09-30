// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import { charactersStore, emptyCharacter } from './characters.svelte';
import RoleplayResponse from './RoleplayResponse.svelte';

afterEach(cleanup);

describe('Narrative response presentation', () => {
  it('renders narrator passages between distinct character replies and preserves order on edits', async () => {
    charactersStore.characters = [emptyCharacter({ id: 'wren', name: 'Wren' }), emptyCharacter({ id: 'aldric', name: 'Aldric' })];
    appStore.chats = [{ id: 'narrative', title: 'Inn', contextMode: 'roleplay', characterId: 'wren', folderId: null, draft: '', createdAt: 1, updatedAt: 1, messages: [], roleplay: { interactionMode: 'narrative', characterIds: ['wren', 'aldric'] } }];
    appStore.currentChatId = 'narrative';
    const view = render(RoleplayResponse, { props: { content: 'Narrator: Rain falls.\nWren: Come inside.\nNarrator: The door opens.\nAldric: You made it.', speakerId: 'wren', status: 'idle' } });
    const parts = () => [...view.container.querySelectorAll('[data-roleplay-narration], [data-roleplay-speaker]')];
    expect(parts().map((part) => part.getAttribute('data-roleplay-speaker'))).toEqual([null, 'wren', null, 'aldric']);
    expect(parts()[0].textContent).toContain('Rain falls.');
    expect(parts()[0].textContent).not.toContain('Narrator:');
    expect(parts()[1].textContent).toContain('Come inside.');
    await view.rerender({ content: 'Wren: Stay here.\nNarrator: Footsteps approach.', speakerId: 'wren', status: 'idle' });
    expect(parts().map((part) => part.getAttribute('data-roleplay-speaker'))).toEqual(['wren', null]);
    expect(view.queryByText('You made it.')).toBeNull();
  });
});
