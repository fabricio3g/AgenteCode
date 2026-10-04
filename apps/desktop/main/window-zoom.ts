import type { WebContents } from 'electron';
import { zoomKeyDirection } from '../shared/zoom-keys.ts';

/** Interface zoom uses the saved setting on both Electron 41 and newer builds. */
export function registerWindowZoom(contents: WebContents): void {
  // setZoomMode was added in Electron 44; it is absent in our Electron 41 build.
  const modern = contents as WebContents & { setZoomMode?: (mode: 'manual') => void };
  if (typeof modern.setZoomMode === 'function') modern.setZoomMode('manual');

  contents.on('zoom-changed', (_event, direction) => {
    contents.send('ui-zoom', direction === 'in' ? 1 : -1);
  });
  contents.on('before-input-event', (event, input) => {
    const direction = input.type === 'keyDown' ? zoomKeyDirection(input.key, input.control || input.meta, input.alt) : null;
    if (direction === null) return;
    event.preventDefault();
    contents.send('ui-zoom', direction);
  });
}
