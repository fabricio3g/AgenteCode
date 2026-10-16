// @vitest-environment jsdom

import { createRawSnippet } from 'svelte';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PaneHeader from './PaneHeader.svelte';

afterEach(cleanup);

const snip = (html: string) => createRawSnippet(() => ({ render: () => html }));

describe('PaneHeader', () => {
  it('puts the title and subtitle left and the actions right', () => {
    const view = render(PaneHeader, {
      props: { title: 'Files', subtitle: '12 files', actions: snip('<button>Refresh</button>') },
    });
    const header = view.container.querySelector('header') as HTMLElement;
    expect(header.querySelector('.ui-pane-header-title')?.textContent).toBe('Files');
    expect(header.querySelector('.ui-pane-header-subtitle')?.textContent).toBe('12 files');
    expect(header.querySelector('.ui-pane-header-actions button')?.textContent).toBe('Refresh');
    expect(header.firstElementChild?.className).toContain('ui-pane-header-main');
  });

  it('forwards attributes and lets children replace the title block', () => {
    const view = render(PaneHeader, {
      props: { 'aria-label': 'Pane', 'data-pane': 'x', children: snip('<span id="own">own</span>') },
    });
    const header = view.container.querySelector('header') as HTMLElement;
    expect(header.getAttribute('aria-label')).toBe('Pane');
    expect(header.dataset.pane).toBe('x');
    expect(header.querySelector('#own')).not.toBeNull();
    expect(header.querySelector('.ui-pane-header-title')).toBeNull();
    expect(header.querySelector('.ui-pane-header-actions')).toBeNull();
  });
});
