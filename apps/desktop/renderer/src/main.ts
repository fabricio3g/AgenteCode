import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './app.css';
import '$lib/i18n/index';
// Interface size, contrast, motion… before the first paint.
import '$lib/stores/accessibility.svelte';
import App from './App.svelte';
import { mount } from 'svelte';

// Dev-only browser harness: ?mock=1 boots a scripted electronAPI before the
// app mounts so the renderer can be driven in a plain browser.
if (new URLSearchParams(location.search).has('mock')) {
  await import('./dev/mock-electron');
}

if (new URLSearchParams(location.search).get('fault') === 'bootstrap') throw new Error('Smoke bootstrap failure');

const app = mount(App, {
  target: document.getElementById('app')!
});

export default app;
