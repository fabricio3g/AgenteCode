import { describe, expect, it } from 'vitest';
import { buildWidgetDocument, WIDGET_CSP } from './widget-kit';
import { splitWidgetSource } from '$lib/services/agent-tool-artifacts';

describe('splitWidgetSource', () => {
  it('moves inline scripts into the script and keeps inline handlers', () => {
    const { html, script } = splitWidgetSource(
      '<button onclick="go()">Go</button><script>function go(){}</script>',
      'let a = 1;'
    );
    expect(html).toBe('<button onclick="go()">Go</button>');
    expect(script).toContain('let a = 1;');
    expect(script).toContain('function go(){}');
  });

  it('drops anything that would load remote content or escape the frame', () => {
    const { html } = splitWidgetSource(
      '<link rel="stylesheet" href="https://x.test/a.css"><iframe src="https://x.test"></iframe><img src="https://x.test/p.png"><style>@import url(https://x.test/b.css); .a{background:url(https://x.test/c.png)}</style>'
    );
    expect(html).not.toMatch(/https:\/\/x\.test/);
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<link');
  });
});

describe('buildWidgetDocument', () => {
  it('seals interactive widgets with a no-network policy and the helpers', () => {
    const doc = buildWidgetDocument({ html: '<p>Hi</p>', script: 'fx.ask("x")', tokens: ':root{}' });
    expect(doc).toContain(WIDGET_CSP);
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain('window.fx');
    expect(doc).toContain('fx.ask("x")');
  });

  it('keeps static cards script-free', () => {
    const doc = buildWidgetDocument({ html: '<p>Hi</p>', tokens: ':root{}' });
    expect(doc).not.toContain('<script');
    expect(doc).toContain('.fx-card');
  });

  it('cannot be broken out of by a closing script tag in the code', () => {
    const doc = buildWidgetDocument({ html: '', script: 'const s = "</script><img src=x>";', tokens: '' });
    expect(doc).toContain('<\\/script><img src=x>');
  });

  it('exposes minimal layout classes and fx.plot / fx.scene3d / fx.sound helpers', () => {
    const doc = buildWidgetDocument({ html: '<div class="fx-stage"></div>', script: 'fx.plot("#a", {});', tokens: ':root{}' });
    expect(doc).toContain('.fx-stage');
    expect(doc).toContain('.fx-kpis');
    expect(doc).toContain('.fx-takeaway');
    expect(doc).toContain('scene3d');
    expect(doc).toContain('sound');
  });
});
