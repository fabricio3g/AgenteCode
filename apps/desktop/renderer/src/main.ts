// Every bundled font is OFL-1.1 (open source, free for commercial use) so
// nothing needs a network fetch at runtime:
//   Inter Variable (opsz)     (OFL) UI and reading fallback beside native OS sans
//   Atkinson Hyperlegible     (OFL) optional reading font, loaded on demand
//   Atkinson Hyperlegible Mono(OFL) its code companion, loaded with it
//
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/inter/opsz-italic.css';
import './app.css';
import '$lib/i18n/index';
// Interface size, contrast, motion, theme, and appearance… before the first paint.
import '$lib/stores/appearance.svelte';
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
