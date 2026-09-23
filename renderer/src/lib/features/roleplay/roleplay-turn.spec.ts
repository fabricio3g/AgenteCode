import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types/chat';
import { createRoleplayTurn, PASSTHROUGH_TURN } from './roleplay-turn';

type Target = Pick<ChatMessage, 'content' | 'choices' | 'props' | 'storyTurn'>;

describe('createRoleplayTurn', () => {
  it('finalizes from the raw stream: choices and props lifted, prose kept', () => {
    const turn = createRoleplayTurn({
      speakerId: 'aiko',
      sampling: {},
      stop: ['\nUser:'],
      sanitize: (text) => text.replace(/^Aiko:\s*/, ''),
      choices: true
    });
    turn.record('Aiko: The door creaks.\n[prop]\ntitle: Key\nbody: Brass.\n[/prop]\n');
    turn.record('[choices]\n- Enter\n- Wait\n[/choices]');

    // The live display text lost the blocks already; finalize must not rely on it.
    const target: Target = { content: 'The door creaks.' };
    turn.finalize(target);

    expect(target.content).toBe('The door creaks.');
    expect(target.choices).toEqual(['Enter', 'Wait']);
    expect(target.props).toEqual([{ title: 'Key', kind: 'object', body: 'Brass.' }]);
  });

  it('trims a stop string the stream died inside of', () => {
    const turn = createRoleplayTurn({ speakerId: null, sampling: {}, stop: ['\nUser:'], choices: false });
    turn.record('She nods.\nUse');
    const target: Target = { content: '' };
    turn.finalize(target);
    expect(target.content).toBe('She nods.');
  });

  it('labels the reply with the story turn it answered', () => {
    const turn = createRoleplayTurn({
      speakerId: null,
      sampling: {},
      stop: ['\nUser:'],
      choices: false,
      storyTurn: { label: 'Twist', kind: 'twist', intensity: 'high', instruction: 'Something breaks.' } as never
    });
    const target: Target = { content: 'Glass shatters.' };
    turn.finalize(target);
    expect(target.storyTurn).toEqual({ label: 'Twist', kind: 'twist', intensity: 'high' });
  });

  it('adds the story turn instruction to the outbound request', () => {
    const turn = createRoleplayTurn({
      speakerId: null,
      sampling: {},
      stop: [],
      choices: false,
      storyTurn: { label: 'Twist', instruction: 'Something breaks.' } as never
    });
    const outbound = turn.decorate([{ role: 'user', content: 'Hi.' }]);
    expect(outbound.at(-1)).toEqual({ role: 'system', content: 'Something breaks.' });
  });
});

describe('PASSTHROUGH_TURN', () => {
  it('leaves requests and replies untouched', () => {
    const messages = [{ role: 'user' as const, content: 'Hi.' }];
    expect(PASSTHROUGH_TURN.decorate(messages)).toBe(messages);
    PASSTHROUGH_TURN.record('ignored');
    const target: Target = { content: 'Name: hello\n[choices]\n- a\n[/choices]' };
    PASSTHROUGH_TURN.finalize(target);
    expect(target).toEqual({ content: 'Name: hello\n[choices]\n- a\n[/choices]' });
    expect(PASSTHROUGH_TURN.speakerId).toBeNull();
  });
});
