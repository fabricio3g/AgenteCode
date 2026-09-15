// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildPreviewHtml } from './preview-builder';

describe('private artifact previews', () => {
  it('blocks active content and navigation in embedded previews', () => {
    const { html } = buildPreviewHtml(`<html><head>
      <base href="https://example.com/"><meta http-equiv="refresh" content="0;url=https://example.com/secret">
      <meta http-equiv="Content-Security-Policy" content="default-src *">
      </head><body><a href="https://example.com/secret" ping="https://example.com/ping">Leak</a>
      <svg><a xlink:href="https://example.com/secret">SVG link<set attributeName="href" to="https://example.com/secret" /></a></svg>
      <iframe srcdoc="secret"></iframe><script>fetch('/secret')</script><form action="https://example.com"></form></body></html>`, {}, 'index.html');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('base, iframe, object, set, animate')).toBeNull();
    expect(doc.querySelector('a[href], a[ping], a[xlink\\:href]')).toBeNull();
    const policies = doc.querySelectorAll('meta[http-equiv]');
    expect(policies).toHaveLength(1);
    expect(policies[0].getAttribute('content')).toContain("script-src 'none'");
    expect(policies[0].getAttribute('content')).toContain("connect-src 'none'");
    expect(policies[0].getAttribute('content')).toContain("form-action 'none'");
    expect(doc.head.firstElementChild).toBe(policies[0]);
  });

  it('keeps local CSS, JS and Unicode assets available to the native runner', () => {
    const { html, externalRefs } = buildPreviewHtml('<link rel="stylesheet" href="./style.css"><script src="./app.js"></script><img src="./icon.svg"><img src="https://example.com/tracker">', {
      'src/style.css': 'body { color: red; }',
      'src/app.js': 'document.body.dataset.ready = "你好";',
      'src/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><text>你好</text></svg>'
    }, 'src/index.html', true);
    expect(html).toContain('body { color: red; }');
    expect(html).toContain('document.body.dataset.ready');
    expect(html).toContain('data:image/svg+xml;charset=utf-8;base64,');
    expect(html).toContain("script-src 'unsafe-inline' data:");
    expect(html).toContain("connect-src 'none'");
    expect(externalRefs).toEqual(['https://example.com/tracker']);
    expect(html).not.toContain('https://example.com/tracker');
  });
});
