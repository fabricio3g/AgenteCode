import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSession, RoleplaySceneState } from '$lib/types/chat';
import { appendRoleplayNudge } from '$lib/stores/app-message-pipeline';
import { createRoleplayTurn, PASSTHROUGH_TURN } from './roleplay-turn';
import { decideTurn, extractScene, parseContributions, sceneForChat, stripSceneBlock } from './roleplay-scene';
import { presetSettings, resolveRoleplaySettings } from './roleplay-settings';
import { extractAddressees, selectNextSpeaker } from './group-turn';
import { emptyCharacter } from '$lib/services/character-card';

const room: RoleplaySceneState = { location: 'Harbor', presentIds: ['wren', 'aldric'], npcs: [], facts: ['Wren has the key.'], goals: ['Find the ship.'], relationships: [] };
const user: ChatMessage = { id: 'u1', role: 'user', content: 'I try to open the gate.', createdAt: 1, done: true };
const chat = (messages: ChatMessage[] = [user]): ChatSession => ({ id: 'scene', title: 'Harbor', contextMode: 'roleplay', characterId: 'wren', folderId: null, draft: '', createdAt: 1, updatedAt: 1, messages, roleplay: { scene: room, characterIds: ['wren', 'aldric'] } });
const names = new Map([['wren', 'Wren'], ['aldric', 'Aldric']]);

describe('Roleplay settings and decisions', () => {
  it('inherits values in order while preserving explicit off/zero and legacy ensemble behavior', () => {
    const resolved = resolveRoleplaySettings({ adventureChoices: true, props: true, choiceTimerSeconds: 60 }, { adventureChoices: false, surprise: 0, allowMultiSpeaker: false });
    expect(resolved.adventureChoices).toBe(false);
    expect(resolved.props).toBe(true);
    expect(resolved.choiceTimerSeconds).toBe(60);
    expect(resolved.surprise).toBe(0);
    expect(resolved.npcDialogue).toBe(false);
    expect(presetSettings({ scene: room, characterIds: ['wren'], journal: [], interactionMode: 'chat' })).not.toHaveProperty('scene');
  });

  it('uses stable seeded decisions and cooldowns without rolling dialogue or completed actions', () => {
    const settings = resolveRoleplaySettings({ interactionMode: 'dynamic', surprise: 100, outcomeRolls: true, outcomeWeights: { success: 0, cost: 1, setback: 0 }, decisionWeights: { opportunity: 1, reaction: 0, connection: 0, discovery: 0, pressure: 0, quiet: 0 } });
    const first = decideTurn(chat(), settings, room, 123);
    expect(first).toEqual(decideTurn(chat(), settings, room, 123));
    expect(first.direction).toBe('opportunity');
    expect(first.outcome).toBe('cost');
    const previous: ChatMessage = { id: 'a1', role: 'assistant', content: 'A ship appears.', createdAt: 2, done: true, metadata: { roleplay: first } };
    expect(decideTurn(chat([previous, user]), settings, room, 123).direction).toBe('quiet');
    expect(decideTurn(chat([{ ...user, content: 'I opened the gate.' }]), settings, room, 123).outcome).toBeUndefined();
    expect(decideTurn(chat([{ ...user, content: 'What do you think?' }]), settings, room, 123).outcome).toBeUndefined();
    expect(decideTurn(chat(), { ...settings, interactionMode: 'chat' }, room, 123).direction).toBe('quiet');
    expect(decideTurn(chat(), { ...settings, interactionMode: 'chat' }, room, 123).instruction).toBe('');
    expect(decideTurn(chat(), { ...settings, interactionMode: 'narrative' }, room, 123).instruction).toBe('');
    expect(decideTurn(chat(), { ...settings, surprise: 0 }, room, 123).direction).toBe('quiet');
  });

  it('filters directions that have no contextual support and respects zero weights', () => {
    const settings = resolveRoleplaySettings({ interactionMode: 'dynamic', surprise: 100, decisionWeights: { reaction: 0, connection: 0, discovery: 0, opportunity: 0, pressure: 100, quiet: 0 } });
    expect(decideTurn(chat([{ ...user, content: 'Hello!' }]), settings, { ...room, location: '', goals: [] }, 10).direction).toBe('quiet');
    expect(decideTurn(chat(), settings, room, 10).direction).toBe('pressure');
  });
});

describe('scene response lifecycle', () => {
  it('keeps Narrative deterministic and stores ordered narrator and character contributions', () => {
    const settings = resolveRoleplaySettings({ interactionMode: 'narrative', surprise: 100, outcomeRolls: true });
    const snapshot = decideTurn(chat(), settings, room, 123);
    expect(snapshot.mode).toBe('narrative');
    expect(snapshot.direction).toBe('quiet');
    expect(snapshot.outcome).toBeUndefined();
    const turn = createRoleplayTurn({ speakerId: 'wren', attribution: { names, speakerName: 'Wren', group: true }, sampling: {}, stop: [], choices: false, snapshot });
    const target: ChatMessage = { id: 'narrative', role: 'assistant', content: 'Narrator: Rain falls.\nWren: Come inside.\nNarrator: The door opens.\nAldric: You made it.\n[scene]{"location":"Inn"}[/scene]', createdAt: 2, done: true };
    turn.finalize(target);
    expect(target.metadata?.roleplay?.contributions.map((part) => part.speakerId)).toEqual([null, 'wren', null, 'aldric']);
    expect(target.metadata?.roleplay?.sceneAfter.location).toBe('Inn');
    expect(target.content).not.toContain('[scene]');
    expect(resolveRoleplaySettings(JSON.parse(JSON.stringify(settings))).interactionMode).toBe('narrative');
  });

  it('keeps bounded NPC exchanges in one response and privately lifts scene state, choices and props', () => {
    const settings = resolveRoleplaySettings({ interactionMode: 'dynamic', adventureChoices: true });
    const snapshot = decideTurn(chat(), settings, room, 3);
    const turn = createRoleplayTurn({ speakerId: 'wren', attribution: { names, speakerName: 'Wren', group: true, allowMultiSpeaker: true, userName: 'Player' }, sampling: {}, stop: ['\nPlayer:'], choices: true, snapshot, sanitize: stripSceneBlock });
    const raw = 'Wren: Aldric, help me.\nAldric: Of course.\n[choices]\n- I follow them.\n[/choices]\n[scene]{"location":"Ship","presentIds":["wren","intruder"],"facts":["They boarded."],"goals":[]}[/scene]';
    turn.record(raw.slice(0, 40)); turn.record(raw.slice(40));
    const target: ChatMessage = { id: 'a1', role: 'assistant', content: '', createdAt: 2, done: true };
    turn.finalize(target);
    expect(target.content).toBe('Wren: Aldric, help me.\nAldric: Of course.');
    expect(target.choices).toEqual(['I follow them.']);
    expect(target.metadata?.roleplay?.sceneAfter.location).toBe('Ship');
    expect(target.metadata?.roleplay?.sceneAfter.presentIds).toEqual(['wren']);
    expect(target.metadata?.roleplay?.sceneAfter.goals).toEqual([]);
    expect(target.metadata?.roleplay?.contributions.map((part) => part.speakerId)).toEqual(['wren', 'aldric']);
    expect(target.metadata?.roleplay?.contributions[0].addresseeIds).toEqual(['aldric']);
    expect(turn.decorate([{ role: 'user', content: 'Hello.' }]).at(-1)?.content).not.toContain('only Wren');
    expect(stripSceneBlock('Hello\n[scene]{"location":')).toBe('Hello');
    expect(stripSceneBlock('Hello\n[sce')).toBe('Hello');
  });

  it('restores the active response version on reload and on rewind', () => {
    const original = decideTurn(chat(), resolveRoleplaySettings({ interactionMode: 'dynamic' }), room, 5);
    original.settled = true;
    const alternate = { ...original, sceneAfter: { ...room, location: 'Forest' } };
    const response: ChatMessage = { id: 'a1', role: 'assistant', content: 'Hello.', done: true, createdAt: 2, versions: [{ content: 'Harbor', createdAt: 2, metadata: { roleplay: original } }, { content: 'Forest', createdAt: 3, metadata: { roleplay: alternate } }], activeVersion: 1 };
    const scene = chat([user, response]);
    expect(sceneForChat(JSON.parse(JSON.stringify(scene))).location).toBe('Forest');
    response.activeVersion = 0;
    expect(sceneForChat(scene).location).toBe('Harbor');
    expect(sceneForChat(scene, 1)).toEqual(room);
    response.done = false;
    response.activeVersion = 1;
    expect(sceneForChat(scene).location).toBe('Harbor');
  });

  it('ignores malformed metadata, disabled memory capture and unknown characters', () => {
    const snapshot = decideTurn(chat(), resolveRoleplaySettings({ interactionMode: 'dynamic', autoMemory: false }), room, 1);
    expect(extractScene('[scene]{broken}[/scene]', snapshot, [...names.keys()])).toEqual(room);
    expect(extractScene('[scene]{"facts":["Invented"],"npcs":[{"id":"npc-x","name":"X","description":"X"}]}[/scene]', snapshot, [...names.keys()])).toEqual(room);
    expect(room.facts).toEqual(['Wren has the key.']);
  });

  it('handles attributed narration and preserves Home/Code passthrough', () => {
    expect(parseContributions('Narrator: Rain falls.\n**Wren:** Come in.', names, 'wren').map((part) => part.speakerId)).toEqual([null, 'wren']);
    const messages = [{ role: 'user' as const, content: 'Write a function.' }];
    expect(PASSTHROUGH_TURN.decorate(messages)).toBe(messages);
    expect(appendRoleplayNudge(messages, undefined)).toBe(messages);
    const target: ChatMessage = { id: 'code', role: 'assistant', content: '[scene]literal code[/scene]', createdAt: 0 };
    PASSTHROUGH_TURN.finalize(target);
    expect(target.content).toBe('[scene]literal code[/scene]');
  });
});

describe('addressees and references', () => {
  const cast = [emptyCharacter({ id: 'wren', name: 'Wren' }), emptyCharacter({ id: 'aldric', name: 'Aldric', aliases: ['Al'] })];
  it('distinguishes references, direct addresses and ensemble invitations', () => {
    expect(extractAddressees('I wonder where Wren went.', cast)).toEqual([]);
    expect(extractAddressees('Aldric, explain it to Wren.', cast)).toEqual(['aldric']);
    expect(extractAddressees('@Al what do you think?', cast)).toEqual(['aldric']);
    expect(extractAddressees('What do you both think?', cast)).toEqual(['wren', 'aldric']);
    expect(selectNextSpeaker({ strategy: 'natural', cast, messages: [{ ...user, content: 'Aldric, answer Wren.' }], random: () => 0 })).toBe('aldric');
    expect(extractAddressees('@Wren [character:second-wren]', [...cast, { id: 'second-wren', name: 'Wren' }])).toEqual(['second-wren']);
  });
});
