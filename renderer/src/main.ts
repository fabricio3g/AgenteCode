import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './app.css';
import '$lib/i18n/index';
import App from './App.svelte';
import { mount } from 'svelte';

// Dev-only browser harness: ?mock=1 boots a scripted electronAPI before the
// app mounts so the renderer can be driven in a plain browser.
if (new URLSearchParams(location.search).has('mock')) {
  await import('./dev/mock-electron');
}

const app = mount(App, {
  target: document.getElementById('app')!
});

export default app;
