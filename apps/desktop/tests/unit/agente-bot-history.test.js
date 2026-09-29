import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { historyTurns, turnSource } from '../../main/agente/bot-history.ts';

const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });

describe('a bot chat replayed for the Code UI', () => {
  it('splits turns at each prompt and keeps tools with their results', () => {
    const turns = historyTurns(
      [
        { role: 'system', content: 'You are Colina (@colina).' },
        { role: 'user', content: '<system-reminder>\nProject instructions\n<system-reminder>' },
        { role: 'user', content: 'What is 17 x 23?' },
        { role: 'assistant', content: 'Asking Scout.', tool_calls: [call('c1', 'message_bot', { to: '@scout', message: '17*23?' })] },
        { role: 'tool', tool_call_id: 'c1', content: '@scout replied:\n\n391' },
        { role: 'assistant', content: '391.' },
        { role: 'user', content: 'Run ls' },
        { role: 'assistant', content: '', tool_calls: [call('c2', 'shell', { command: 'ls' })] },
        { role: 'tool', tool_call_id: 'c2', content: 'Error: denied' }
      ],
      'bot:colina'
    );
    assert.equal(turns.length, 2);
    assert.equal(turns[0].prompt, 'What is 17 x 23?');
    const types = turns[0].events.map((event) => event.type);
    assert.deepEqual(types.filter((t) => t !== 'turn_start' && t !== 'turn_end'), ['agent_start', 'text_delta', 'tool_start', 'tool_end', 'text_delta', 'agent_end']);
    const start = turns[1].events.find((event) => event.type === 'tool_start');
    assert.equal(start.toolName, 'bash');
    assert.deepEqual(start.args, { command: 'ls' });
    const end = turns[1].events.find((event) => event.type === 'tool_end');
    assert.equal(end.isError, true);
    assert.ok(turns.every((turn) => turn.events.every((event) => event.chatId === 'bot:colina')));
  });

  it('says who asked: you, a routine or another bot', () => {
    assert.deepEqual(turnSource('hello'), { prompt: 'hello', source: { kind: 'user' } });
    assert.deepEqual(turnSource('Routine “Morning brief”:\n\nWhat is on today?'), {
      prompt: 'What is on today?',
      source: { kind: 'routine', title: 'Morning brief' }
    });
    assert.deepEqual(
      turnSource('Message from @colina (another bot on your team):\n\nWhat is 17*23?\n\nYour reply goes back to @colina.'),
      { prompt: 'What is 17*23?', source: { kind: 'handoff', from: 'colina' } }
    );
  });
});
