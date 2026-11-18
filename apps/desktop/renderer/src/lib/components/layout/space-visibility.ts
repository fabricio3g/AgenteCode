/**
 * Whether the space a component lives in is the one on screen.
 *
 * A space stays mounted while another is shown (switching back costs nothing
 * and a running session keeps its scroll and terminals), so "mounted" no
 * longer means "visible". Anything that acts on the whole window — a key
 * listener, a native browser view, a write to the shared layout — asks this
 * first. Outside a space layer it is always true.
 */
import { getContext, setContext } from 'svelte';

const KEY = Symbol('space-visible');

export function provideSpaceVisible(visible: () => boolean): void {
  setContext(KEY, visible);
}

export function spaceVisible(): () => boolean {
  return getContext<(() => boolean) | undefined>(KEY) ?? (() => true);
}
