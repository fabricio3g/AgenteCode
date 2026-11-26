// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  buildElicitationContent,
  initialElicitationState,
  parseElicitationSchema,
  validateElicitationAnswers
} from './elicitation-schema';
import { userInputsStore } from '$lib/stores/user-inputs.svelte';

describe('elicitation schema parsing and answer building', () => {
  const openCodeSchema = {
    type: 'object',
    properties: {
      q0: {
        type: 'string',
        title: 'Color',
        description: 'Which color do you prefer?',
        oneOf: [
          { const: 'Red', title: 'Red', description: 'A warm color' },
          { const: 'Blue', title: 'Blue', description: 'A cool color' }
        ]
      },
      q0_custom: {
        type: 'string',
        title: 'Color (other)',
        description: 'Type your own answer'
      },
      q1: {
        type: 'array',
        title: 'Fruits',
        description: 'Which fruits do you like?',
        items: {
          anyOf: [
            { const: 'Apple', title: 'Apple', description: 'Crisp' },
            { const: 'Orange', title: 'Orange', description: 'Citrus' }
          ]
        }
      },
      q1_custom: {
        type: 'string',
        title: 'Fruits (other)',
        description: 'Add your own answer'
      }
    },
    required: ['q0']
  };

  it('pairs *_custom fields with single_select and multi_select fields', () => {
    const fields = parseElicitationSchema(openCodeSchema);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({
      kind: 'single_select',
      key: 'q0',
      title: 'Color',
      required: true,
      customKey: 'q0_custom',
      customPlaceholder: 'Type your own answer'
    });
    expect(fields[1]).toMatchObject({
      kind: 'multi_select',
      key: 'q1',
      title: 'Fruits',
      required: false,
      customKey: 'q1_custom'
    });

    const state = initialElicitationState(fields);
    expect(validateElicitationAnswers(fields, state)).toBe('Color');

    state.values.q0 = 'Blue';
    state.values.q1 = ['Apple'];
    state.customValues.q1 = 'Mango';
    expect(validateElicitationAnswers(fields, state)).toBeNull();
    expect(buildElicitationContent(fields, state)).toEqual({
      q0: 'Blue',
      q1: ['Apple'],
      q1_custom: 'Mango'
    });

    // When custom answer overrides single_select
    state.customValues.q0 = 'Purple';
    expect(buildElicitationContent(fields, state)).toEqual({
      q0_custom: 'Purple',
      q1: ['Apple'],
      q1_custom: 'Mango'
    });
  });

  it('handles text, number, integer, enum, and boolean schema fields', () => {
    const fields = parseElicitationSchema({
      type: 'object',
      properties: {
        env: { type: 'string', enum: ['dev', 'prod'], default: 'dev' },
        workers: { type: 'integer', title: 'Workers', default: 4 },
        confirm: { type: 'boolean', title: 'Proceed', default: true },
        notes: { type: 'string', title: 'Notes' }
      },
      required: ['workers', 'notes']
    });
    const state = initialElicitationState(fields);
    expect(validateElicitationAnswers(fields, state)).toBe('Notes');
    state.values.notes = 'Ship it';
    expect(buildElicitationContent(fields, state)).toEqual({
      env: 'dev',
      workers: 4,
      confirm: true,
      notes: 'Ship it'
    });
  });

  it('queues and resolves/clears pending user input requests', async () => {
    const p1 = userInputsStore.request({
      id: 'inp-1',
      chatId: 'chat-a',
      message: 'Questions',
      schema: openCodeSchema
    });
    expect(userInputsStore.forChat('chat-a')).toHaveLength(1);
    userInputsStore.resolve('inp-1', { action: 'accept', content: { q0: 'Red' } });
    expect(await p1).toEqual({ action: 'accept', content: { q0: 'Red' } });
    expect(userInputsStore.forChat('chat-a')).toHaveLength(0);

    const p2 = userInputsStore.request({
      id: 'inp-2',
      chatId: 'chat-a',
      message: 'Cancelled on turn end',
      schema: {}
    });
    userInputsStore.clearForChat('chat-a');
    expect(await p2).toEqual({ action: 'cancel' });
  });
});
