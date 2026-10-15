/**
 * The models picked lately, cloud and on-device mixed, newest first. The
 * picker's first screen is this list: most choices are a return to one of a
 * few models, so they should not need a provider or a source first.
 */

export type RecentModel =
  | { kind: 'cloud'; provider: string; model: string; name: string }
  | { kind: 'local'; id: string; name: string; path: string };

const KEY = 'agente.recentModels';
const LIMIT = 5;

export function recentKey(entry: RecentModel): string {
  return entry.kind === 'cloud' ? `cloud:${entry.provider}/${entry.model}` : `local:${entry.path || entry.id}`;
}

function read(): RecentModel[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && (item.kind === 'cloud' || item.kind === 'local')) : [];
  } catch {
    return [];
  }
}

class RecentModels {
  list = $state<RecentModel[]>(read());

  remember(entry: RecentModel) {
    const key = recentKey(entry);
    this.list = [entry, ...this.list.filter((item) => recentKey(item) !== key)].slice(0, LIMIT);
    try { localStorage.setItem(KEY, JSON.stringify(this.list)); } catch { /* Session-only. */ }
  }
}

export const recentModels = new RecentModels();
