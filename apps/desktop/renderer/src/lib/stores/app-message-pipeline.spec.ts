import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types/chat';
import { referenceImages } from '$lib/services/design-references';
import { normalizeAgentHistory } from '$lib/services/agent-run-plan';
import { buildRequestMessagesFromHistory } from '$lib/stores/app-store-helpers';
import {
  appendRoleplayNudge,
  appendRoleplayStoryTurn,
  buildRequestMessagesWithPatchedUser,
  type RoleplayAttribution
} from '$lib/stores/app-message-pipeline';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: `msg-${Math.random()}`,
    role: 'assistant',
    content: '',
    createdAt: 0,
    ...overrides
  };
}

const attribution: RoleplayAttribution = {
  names: new Map([
    ['aiko', 'Aiko'],
    ['ren', 'Ren']
  ]),
  userName: 'Sam',
  group: true,
  speakerName: 'Ren'
};

describe('buildRequestMessagesWithPatchedUser attribution', () => {
  it('delivers image-only messages and preserves earlier images for Design and Home', () => {
    const attachment = { id:'image', name:'reference.png', size:3, type:'image/png', kind:'image' as const, base64:'data:image/png;base64,AAAA' };
    const rows: ChatMessage[] = [message({id:'old',role:'user',content:'',attachments:[attachment]}),message({id:'current',role:'user',content:'',attachments:[attachment]})];
    const outbound = buildRequestMessagesWithPatchedUser({messages:rows,assistantMessageId:'answer',userMessageId:'current',userContent:'',buildContextualPrompt: text => text});
    expect(outbound).toHaveLength(2);
    expect(referenceImages(outbound[1])).toEqual([{name:'reference.png',data:'AAAA'}]);
    expect(referenceImages(normalizeAgentHistory(outbound)[1])).toEqual([{name:'reference.png',data:'AAAA'}]);
    expect(outbound[0].attachments?.[0].base64).toBe(attachment.base64);
    expect(buildRequestMessagesFromHistory(rows)[0].attachments?.[0].base64).toBe(attachment.base64);
  });
  it('prefixes group turns with their speaker name', () => {
    const messages = [
      message({ id: 'm1', speakerId: 'aiko', content: '"You again?"' }),
      message({ id: 'm2', role: 'user', content: 'Sorry I am late.' }),
      message({ id: 'm3', speakerId: 'ren', content: 'It happens.' })
    ];

    const outbound = buildRequestMessagesWithPatchedUser({
      messages,
      assistantMessageId: 'none',
      userMessageId: 'm2',
      userContent: 'Sorry I am late.',
      buildContextualPrompt: (content) => content,
      attribution
    });

    expect(outbound.map((entry) => entry.content)).toEqual([
      'Aiko: "You again?"',
      'Sam: Sorry I am late.',
      'Ren: It happens.'
    ]);
  });

  it('leaves narration (no speaker) unattributed', () => {
    const outbound = buildRequestMessagesWithPatchedUser({
      messages: [message({ id: 'm1', speakerId: null, content: 'The lanterns rise.' })],
      assistantMessageId: 'none',
      userMessageId: 'missing',
      userContent: '',
      buildContextualPrompt: (content) => content,
      attribution
    });
    expect(outbound[0]?.content).toBe('The lanterns rise.');
  });

  it('does not touch 1:1 scenes', () => {
    const outbound = buildRequestMessagesWithPatchedUser({
      messages: [message({ id: 'm1', speakerId: 'aiko', content: 'Hi.' })],
      assistantMessageId: 'none',
      userMessageId: 'missing',
      userContent: '',
      buildContextualPrompt: (content) => content,
      attribution: { ...attribution, group: false }
    });
    expect(outbound[0]?.content).toBe('Hi.');
  });
});

describe('appendRoleplayNudge', () => {
  it('ends group requests with a one-speaker nudge', () => {
    const nudged = appendRoleplayNudge([{ role: 'user', content: 'Hi.' }], attribution);
    expect(nudged).toHaveLength(2);
    expect(nudged[1]?.role).toBe('system');
    expect(nudged[1]?.content).toContain("only Ren's reply");
    expect(nudged[1]?.content).toContain('Sam');
  });

  it('adds nothing for 1:1 scenes or missing speakers', () => {
    const messages = [{ role: 'user' as const, content: 'Hi.' }];
    expect(appendRoleplayNudge(messages, { ...attribution, group: false })).toHaveLength(1);
    expect(appendRoleplayNudge(messages, undefined)).toHaveLength(1);
  });
});

describe('appendRoleplayStoryTurn', () => {
  it('adds the turn before the caller adds anything after it', () => {
    const turn = appendRoleplayStoryTurn([{ role: 'user', content: 'Hi.' }], 'Someone arrives.');
    expect(turn).toHaveLength(2);
    expect(turn[1]).toEqual({ role: 'system', content: 'Someone arrives.' });
  });

  it('leaves the thread alone when nothing was queued', () => {
    const messages = [{ role: 'user' as const, content: 'Hi.' }];
    expect(appendRoleplayStoryTurn(messages, undefined)).toHaveLength(1);
    expect(appendRoleplayStoryTurn(messages, null)).toHaveLength(1);
    expect(appendRoleplayStoryTurn(messages, '   ')).toHaveLength(1);
  });

  it('never lands as the user speaking', () => {
    // The user did not write it, so it must not read as their dialogue.
    const turn = appendRoleplayStoryTurn([{ role: 'user', content: 'Hi.' }], 'The moment passes.');
    expect(turn[1]?.role).toBe('system');
    expect(turn[0]?.role).toBe('user');
    expect(turn[0]?.content).toBe('Hi.');
  });
});
