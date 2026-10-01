import { getContext, setContext } from 'svelte';

const VIEWER_CONTROLS = Symbol('viewer-controls');

export interface ViewerAction {
  label: string;
  run: () => void;
  active?: boolean;
  disabled?: boolean;
}

export interface ViewerCapabilities {
  page?: number;
  pages?: number;
  goToPage?: (page: number) => void;
  zoom?: string;
  zoomBy?: (direction: 1 | -1) => void;
  fit?: () => void;
  search?: { matches: number; index: number; step?: (direction: 1 | -1) => void };
  actions?: ViewerAction[];
  retry?: () => void;
}

/** One scope per reader, with no callbacks shared between mounted readers. */
export function createViewerControls() {
  const controls = $state({
    current: null as (ViewerCapabilities & { owner: symbol }) | null,
    query: '',
    searchOpen: false,
    title: '',
    download: null as (() => void) | null
  });
  return controls;
}
export type ViewerControls = ReturnType<typeof createViewerControls>;

export function provideViewerControls(controls: ViewerControls) {
  setContext(VIEWER_CONTROLS, controls);
}
export function useViewerControls(): ViewerControls | undefined {
  return getContext(VIEWER_CONTROLS);
}

/** An outgoing renderer may only clear its own registration. */
export function registerViewerControls(controls: ViewerControls | undefined, read: () => ViewerCapabilities | null) {
  const owner = Symbol('renderer');
  $effect(() => {
    const capabilities = read();
    if (!controls || !capabilities) return;
    controls.current = { ...capabilities, owner };
    return () => {
      if (controls.current?.owner === owner) controls.current = null;
    };
  });
}

/** Scoped shortcuts: focus in a different reader or the composer is untouched. */
export function viewerShortcuts(node: HTMLElement, controls: ViewerControls) {
  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    if (closeViewerSearch(event, controls)) return;
    if (event.ctrlKey || event.metaKey) handleModifier(event, controls);
  }
  node.addEventListener('keydown', onKeydown);
  return { destroy: () => node.removeEventListener('keydown', onKeydown) };
}

export function closeViewerSearch(event: KeyboardEvent, controls: ViewerControls) {
  if (event.key !== 'Escape' || !controls.searchOpen) return false;
  event.preventDefault();
  event.stopPropagation();
  controls.searchOpen = false;
  controls.query = '';
  return true;
}
function handleModifier(event: KeyboardEvent, controls: ViewerControls) {
  if (event.key.toLowerCase() === 'f') {
    if (!controls.current?.search) return;
    event.preventDefault();
    controls.searchOpen = true;
    return;
  }
  if ((event.target as HTMLElement).closest('input, textarea, [contenteditable=true]')) return;
  const keys: Record<string, () => void> = {
    '+': () => controls.current?.zoomBy?.(1),
    '=': () => controls.current?.zoomBy?.(1),
    '-': () => controls.current?.zoomBy?.(-1),
    '0': () => controls.current?.fit?.()
  };
  const action = keys[event.key];
  if (action && controls.current?.zoomBy) { event.preventDefault(); action(); }
}
