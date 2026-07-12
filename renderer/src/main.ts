import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './app.css';
import '$lib/i18n/index';
import App from './App.svelte';
import { mount } from 'svelte';

const app = mount(App, {
  target: document.getElementById('app')!
});

export default app;
