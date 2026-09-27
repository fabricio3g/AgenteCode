import { getContext, setContext } from 'svelte';

const VIEWER_CONTROLS = Symbol('viewer-controls');

/** Per-reader controls; renderers register only capabilities they implement. */
export function createViewerControls() {
  return $state({
    page: 1,
    pages: 0,
    zoom: 'fit' as string,
    canZoom: false,
    wrap: true,
    canWrap: false,
    goToPage: null as ((page: number) => void) | null,
    retry: null as (() => void) | null
  });
}

export type ViewerControls = ReturnType<typeof createViewerControls>;

export function provideViewerControls(controls: ViewerControls) {
  setContext(VIEWER_CONTROLS, controls);
}

export function useViewerControls(): ViewerControls | undefined {
  return getContext(VIEWER_CONTROLS);
}
