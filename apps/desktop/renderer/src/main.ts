// Every font is bundled and OFL-1.1 (open source, free for commercial use), so
// no surface falls back to a licensed platform face and nothing needs a
// network fetch at runtime:
//   Geist Variable            (OFL) UI and reading text
//   Geist Mono Variable       (OFL) code, diffs and the terminal
//   Atkinson Hyperlegible     (OFL) optional reading font, loaded on demand
//   Atkinson Hyperlegible Mono(OFL) its code companion, loaded with it
// A new face only lands here if it is OFL or otherwise free for commercial use.
//
import '@fontsource-variable/geist';
import '@fontsource-variable/geist/wght-italic.css';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/geist-mono/wght-italic.css';
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
