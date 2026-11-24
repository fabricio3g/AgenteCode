import { describe, expect, it } from 'vitest';
import type { SwarmBoard, SwarmCard } from '$shared/agente-protocol';
import { feedsOf, findingRoute, lanesFor, recentFindings } from './swarm-lanes';

const card = (id: string, extra: Partial<SwarmCard> = {}): SwarmCard => ({
  id, title: id.toUpperCase(), role: 'Reader', capability: 'read-only', prompt: '', status: 'working', ...extra
});

const board: SwarmBoard = {
  enabled: true,
  cards: [
    card('c1', { child_id: 'a' }),
    card('c2', { child_id: 'b', status: 'done' }),
    card('c3', { status: 'backlog', depends_on: ['c1'] }),
    card('c4', { child_id: 'z' }),
    card('c5', { status: 'backlog', depends_on: ['c4'] })
  ],
  findings: [
    { id: 1, from: 'c1', text: 'one' },
    { id: 2, from: 'c4', text: 'other swarm turn' },
    { id: 3, from: 'c2', text: 'to c1', to: ['c1'] },
    { id: 4, from: 'lead', text: 'keep the api' }
  ]
};

describe('swarm lanes', () => {
  it('takes the cards the turn\'s children work, plus the backlog waiting on them', () => {
    expect(lanesFor(board, new Set(['a', 'b'])).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(lanesFor(board, new Set(['nobody']))).toEqual([]);
    expect(lanesFor(null, new Set(['a']))).toEqual([]);
  });

  it('names the cards a card feeds', () => {
    expect(feedsOf(board, board.cards[0])).toEqual(['c3']);
    expect(feedsOf(board, board.cards[1])).toEqual([]);
  });

  it('keeps the newest findings, narrowed to the lanes shown', () => {
    expect(recentFindings(board, 2).map((f) => f.id)).toEqual([3, 4]);
    expect(recentFindings(board, 10, new Set(['c1', 'c2', 'c3'])).map((f) => f.id)).toEqual([1, 3, 4]);
  });

  it('routes a finding from its author to its addressees', () => {
    expect(findingRoute({ id: 1, from: 'c2', text: '', to: ['c1', 'c3'] })).toBe('c2 → c1, c3');
    expect(findingRoute({ id: 2, from: 'lead', text: '' })).toBe('lead');
  });
});
