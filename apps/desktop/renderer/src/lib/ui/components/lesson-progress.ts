/**
 * Where the reader stopped, so reopening a lesson lands on the same block.
 *
 * One number per lesson (`index`) — no score, no percentage, no streak. Keyed by
 * the artifact's entry path rather than the chat, so the same lesson reopened
 * from the library continues too. Sessions never contain lesson content: only a
 * position, capped to the newest 200 lessons.
 */

const KEY = 'agente:lesson-progress:v1';
const LIMIT = 200;

type ProgressMap = Record<string, { index: number; at: number }>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): ProgressMap {
  const raw = storage()?.getItem(KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ProgressMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(map: ProgressMap): void {
  const entries = Object.entries(map)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, LIMIT);
  try {
    storage()?.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // A full quota is not worth breaking a lesson over.
  }
}

export function lessonProgressKey(title: string, entryPath?: string): string {
  return (entryPath || title || 'lesson').trim();
}

export function loadLessonProgress(key: string): number | null {
  const entry = read()[key];
  return entry && Number.isFinite(entry.index) ? entry.index : null;
}

export function saveLessonProgress(key: string, index: number): void {
  if (!key || !Number.isFinite(index) || index <= 0) return;
  const map = read();
  map[key] = { index: Math.floor(index), at: Date.now() };
  write(map);
}
