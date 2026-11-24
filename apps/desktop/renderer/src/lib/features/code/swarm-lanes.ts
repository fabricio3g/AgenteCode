// Reading the swarm board as lanes: which cards a turn's subagents work, who
// waits on whom, and the findings members posted to each other. Pure, so the
// transcript's swarm block and the Board pane read the board the same way.

import type { SwarmBoard, SwarmCard, SwarmFinding } from '$shared/agente-protocol';

/**
 * The cards a turn's subagents work, in board order: the swarm block draws one
 * lane per card whose subagent is among `childIds`. Cards waiting on those
 * (still in the backlog) join too, so the block shows what comes next.
 */
export function lanesFor(board: SwarmBoard | null, childIds: ReadonlySet<string>): SwarmCard[] {
  const cards = board?.cards ?? [];
  const mine = new Set(cards.filter((card) => card.child_id && childIds.has(card.child_id)).map((card) => card.id));
  if (!mine.size) return [];
  return cards.filter((card) => mine.has(card.id) || (card.status === 'backlog' && (card.depends_on ?? []).some((dep) => mine.has(dep))));
}

/** The cards that wait on `card` — who its result goes to. */
export function feedsOf(board: SwarmBoard | null, card: SwarmCard): string[] {
  return (board?.cards ?? []).filter((other) => (other.depends_on ?? []).includes(card.id)).map((other) => other.id);
}

/** The newest `limit` findings, oldest first, optionally only those touching `cards`. */
export function recentFindings(board: SwarmBoard | null, limit: number, cards?: ReadonlySet<string>): SwarmFinding[] {
  const all = board?.findings ?? [];
  const touching = cards ? all.filter((finding) => finding.from === 'lead' || cards.has(finding.from) || (finding.to ?? []).some((to) => cards.has(to))) : all;
  return touching.slice(Math.max(0, touching.length - limit));
}

/** Who a finding came from and went to, the way the block heads it: `c1 → c2`, `lead`. */
export function findingRoute(finding: SwarmFinding): string {
  const to = finding.to?.length ? ` → ${finding.to.join(', ')}` : '';
  return `${finding.from}${to}`;
}
