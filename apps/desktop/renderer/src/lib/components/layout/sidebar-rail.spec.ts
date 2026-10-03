import { describe, expect, it } from 'vitest';

/**
 * The sidebar rail's one recipe, guarded.
 *
 * Five components render rows in the rail and each used to declare its own:
 * eleven copies of the accent fill, four row heights, four section-label styles
 * and two copies of the same pulse keyframes. Nothing failed when they drifted
 * apart, because drift is invisible to a type checker. These assertions make the
 * shared recipe load-bearing — the second copy fails the suite instead of the
 * design review.
 *
 * The recipe itself lives in app.css (`.sidebar-row`, `.sidebar-section`,
 * `.sidebar-dot`, `--sidebar-row-h`).
 */

const RAIL = [
  './Sidebar.svelte',
  './SidebarInstances.svelte',
  '../../features/shared/SessionRow.svelte',
  '../../features/code/CodeSidebar.svelte',
  '../../features/bots/BotRoster.svelte'
] as const;

const SOURCES = import.meta.glob<string>(['./Sidebar.svelte', './SidebarInstances.svelte', '../../features/shared/SessionRow.svelte', '../../features/code/CodeSidebar.svelte', '../../features/bots/BotRoster.svelte'], {
  query: '?raw',
  import: 'default',
  eager: true
});

/** Every .svelte file in the renderer, for the app-wide half of the guard. */
const ALL_SOURCES = import.meta.glob<string>(['../../../**/*.svelte'], { query: '?raw', import: 'default', eager: true });

function source(path: string): string {
  const text = SOURCES[path];
  expect(text, `${path} is missing from the rail guard's glob`).toBeTruthy();
  return text;
}

describe('sidebar rail', () => {
  it('renders every row through the shared recipe', () => {
    const missing = RAIL.filter((path) => !source(path).includes('sidebar-row'));
    expect(missing).toEqual([]);
  });

  it('keeps the accent fill in one place', () => {
    // The rail's hover/current fill is `.sidebar-row` in app.css. A component
    // reaching for the token directly is a second copy of the recipe.
    const offenders = Object.entries(ALL_SOURCES)
      .filter(([, text]) => text.includes('var(--sidebar-accent'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('declares no row height of its own', () => {
    // `--sidebar-row-h` is the one height; a utility here is how the rail grew
    // four of them (28px, 30.4px, and two padding-derived sizes).
    const offenders = RAIL.filter((path) => /\bh-7\b/.test(source(path)));
    expect(offenders).toEqual([]);
  });

  it('declares no pulse of its own', () => {
    // One keyframe set, in app.css, behind `.sidebar-dot`.
    const offenders = RAIL.filter((path) => /@keyframes\s+[\w-]*pulse/i.test(source(path)));
    expect(offenders).toEqual([]);
  });

  it('declares no status dot of its own', () => {
    // StatusDot owns the geometry; a rail component sizing its own dot is the
    // duplication this replaced (three sizes across four components).
    const offenders = RAIL.filter((path) => /\.(status|working|running)-dot\s*\{/.test(source(path)));
    expect(offenders).toEqual([]);
  });
});
