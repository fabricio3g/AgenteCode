import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { createBlankRoleplayCharacter } from '../../renderer/src/lib/services/roleplay-card.ts';

describe('roleplay character creation', () => {
  it('creates a blank editable character without imported card payload', () => {
    const character = createBlankRoleplayCharacter();

    assert.equal(character.name, 'New character');
    assert.equal(character.description, '');
    assert.equal(character.personality, '');
    assert.equal(character.scenario, '');
    assert.equal(character.firstMessage, '');
    assert.equal(character.exampleDialogue, '');
    assert.equal(character.creatorNotes, '');
    assert.deepEqual(character.tags, []);
    assert.equal(character.sourceFormat, 'unknown-json');
    assert.equal(character.rawPayload, undefined);
  });

  it('keeps avatar data on the shared rendered image field', () => {
    const character = createBlankRoleplayCharacter({ avatarDataUrl: 'data:image/png;base64,avatar' });

    assert.equal(character.avatarDataUrl, 'data:image/png;base64,avatar');
  });

  it('supports attaching lorebooks to characters', () => {
    const hub = readFileSync('renderer/src/lib/components/roleplay/CharacterHub.svelte', 'utf8');
    const store = readFileSync('renderer/src/lib/stores/roleplay.svelte.ts', 'utf8');
    const prompt = readFileSync('renderer/src/lib/services/roleplay-prompt.ts', 'utf8');

    assert.match(hub, /Character lorebooks/);
    assert.match(hub, /selectedCharacterLorebookIds/);
    assert.match(store, /attachedLorebookIds/);
    assert.match(store, /toggleCharacterLorebook/);
    assert.match(prompt, /characterLorebookIds/);
    assert.match(prompt, /extraLorebookIds/);
  });
});

describe('roleplay character hub UI wiring', () => {
  it('exposes create, replace image, remove image, paste, and URL image controls', () => {
    const hub = readFileSync('renderer/src/lib/components/roleplay/CharacterHub.svelte', 'utf8');
    const store = readFileSync('renderer/src/lib/stores/roleplay.svelte.ts', 'utf8');

    assert.match(hub, /Create character/);
    assert.match(hub, /Replace image/);
    assert.match(hub, /Remove image/);
    assert.match(hub, /onpaste=\{pasteImage\}/);
    assert.match(hub, /placeholder="Image URL"/);
    assert.match(store, /createCharacter\(/);
    assert.match(store, /updateCharacterImageFromFile/);
    assert.match(store, /updateCharacterImageFromClipboard/);
    assert.match(store, /updateCharacterImageFromUrl/);
    assert.match(store, /removeCharacterImage/);
  });

  it('keeps self profile in its own modal and quick scene actions in workspace', () => {
    const hub = readFileSync('renderer/src/lib/components/roleplay/CharacterHub.svelte', 'utf8');
    const workspace = readFileSync('renderer/src/lib/components/roleplay/RoleplayWorkspace.svelte', 'utf8');
    const selfModal = readFileSync('renderer/src/lib/components/roleplay/SelfProfileModal.svelte', 'utf8');
    const store = readFileSync('renderer/src/lib/stores/roleplay.svelte.ts', 'utf8');

    assert.doesNotMatch(hub, /Self profile/);
    assert.match(hub, /Current scene/);
    assert.match(hub, /toggleCharacterLorebook/);
    assert.match(workspace, /SelfProfileModal/);
    assert.match(workspace, />Self</);
    assert.match(selfModal, /Apply to scene speaker/);
    assert.match(selfModal, /Load Self into cast/);
    assert.match(store, /selfProfile/);
    assert.match(store, /updateSelfProfile/);
    assert.match(store, /resetSelfProfile/);
    assert.match(store, /applySelfToCurrentChat/);
  });
});

describe('roleplay history UI wiring', () => {
  it('uses roleplay chats with normal chat list affordances', () => {
    const workspace = readFileSync('renderer/src/lib/components/roleplay/RoleplayWorkspace.svelte', 'utf8');

    assert.match(workspace, /roleplayStore\.chats/);
    assert.doesNotMatch(workspace, /appStore\.chats/);
    assert.match(workspace, /Search class=/);
    assert.match(workspace, /groupLabel/);
    assert.match(workspace, /startRename/);
    assert.match(workspace, /roleplayStore\.renameChat/);
    assert.match(workspace, /Delete scene/);
    assert.match(workspace, /New scene/);
  });

  it('renders a fixed roleplay cast indicator derived from activeCharacterIds', () => {
    const workspace = readFileSync('renderer/src/lib/components/roleplay/RoleplayWorkspace.svelte', 'utf8');

    assert.match(workspace, /new Set\(chat\.activeCharacterIds\)/);
    assert.match(workspace, /class="cast-indicator/);
    assert.match(workspace, /class="cast-popover/);
    assert.match(workspace, /No cast/);
    assert.match(workspace, /min-height: 76px/);
  });

  it('renders scene header quick cast and lorebook controls', () => {
    const workspace = readFileSync('renderer/src/lib/components/roleplay/RoleplayWorkspace.svelte', 'utf8');

    assert.match(workspace, />Scene</);
    assert.match(workspace, />Cast</);
    assert.match(workspace, />Lorebooks</);
    assert.match(workspace, />Self</);
    assert.match(workspace, /LorebookSelectorModal/);
  });

  it('renders a minimal empty-scene welcome and moves setup controls into the scene modal', () => {
    const workspace = readFileSync('renderer/src/lib/components/roleplay/RoleplayWorkspace.svelte', 'utf8');
    const modal = readFileSync('renderer/src/lib/components/roleplay/SceneSettingsModal.svelte', 'utf8');

    assert.match(workspace, /Ready for a new adventure/);
    assert.match(workspace, /Start adventure/);
    assert.match(workspace, /message-avatar/);
    assert.match(workspace, /ReasoningBlock/);
    assert.match(workspace, /autoOpenOnStreaming=\{false\}/);
    assert.match(workspace, /sceneSetupComplete/);
    assert.match(workspace, /createSceneWithSettings/);
    assert.match(modal, /Scenario/);
    assert.match(modal, /oneToOne/);
    assert.match(modal, /Group Chat/);
    assert.match(modal, /Narrative/);
    assert.match(modal, /LorebookSelectorModal/);
    assert.match(modal, /group/);
    assert.match(modal, /allowNarrator/);
    assert.match(modal, /maxSpeakerTurns/);
    assert.match(modal, /Start adventure/);
    assert.match(modal, /Primary character/);
  });
});
