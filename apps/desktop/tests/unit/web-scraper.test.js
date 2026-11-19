import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScrapeQuality,
  compactExtractedText,
  detectDocumentKind,
  isHttpUrl,
  isSafePublicUrl,
  normalizeAbsoluteUrl,
  parseHtmlToReadable,
  scrapeUrlStructured
} from '../../main/web-scraper.ts';

describe('web-scraper helpers', () => {
  it('classifies blocked HTTP statuses and auth errors', () => {
    assert.equal(classifyScrapeQuality({ status: 403, error: 'HTTP 403' }).quality, 'blocked');
    assert.equal(classifyScrapeQuality({ status: 401, error: 'HTTP 401' }).quality, 'blocked');
    assert.equal(classifyScrapeQuality({ status: 429, error: 'HTTP 429' }).quality, 'blocked');
    assert.equal(classifyScrapeQuality({ error: 'Forbidden by site' }).quality, 'blocked');
  });

  it('classifies thin content and healthy pages', () => {
    const thin = classifyScrapeQuality({ content: 'short page', title: 'Thin' });
    assert.equal(thin.quality, 'thin_content');
    assert.match(thin.warning, /characters could be extracted/i);

    const ok = classifyScrapeQuality({
      content: 'x'.repeat(800),
      title: 'Solid article'
    });
    assert.equal(ok.quality, 'ok');
    assert.equal(ok.warning, '');
  });

  it('validates http(s) urls only', () => {
    assert.equal(isHttpUrl('https://example.com/a'), true);
    assert.equal(isHttpUrl('http://example.com'), true);
    assert.equal(isHttpUrl('ftp://example.com'), false);
    assert.equal(isHttpUrl('not a url'), false);
    assert.equal(isHttpUrl(''), false);
  });

  it('blocks SSRF targets and private networks while allowing domains starting with fc/fd', () => {
    assert.equal(isSafePublicUrl('https://example.com/docs.pdf'), true);
    assert.equal(isSafePublicUrl('https://fcc.gov/news'), true);
    assert.equal(isSafePublicUrl('https://fdic.gov/bank'), true);
    assert.equal(isSafePublicUrl('https://fdroid.org/en/'), true);
    assert.equal(isSafePublicUrl('https://[2606:4700:4700::1111]/'), true);
    assert.equal(isSafePublicUrl('https://[::ffff:8.8.8.8]/'), true);

    assert.equal(isSafePublicUrl('http://127.0.0.1/secret'), false);
    assert.equal(isSafePublicUrl('http://localhost:3000'), false);
    assert.equal(isSafePublicUrl('http://192.168.1.10/x'), false);
    assert.equal(isSafePublicUrl('http://10.0.0.5/x'), false);
    assert.equal(isSafePublicUrl('http://169.254.169.254/latest/meta-data'), false);
    assert.equal(isSafePublicUrl('http://[::]/'), false);
    assert.equal(isSafePublicUrl('http://[::1]/'), false);
    assert.equal(isSafePublicUrl('http://[fe80::1]/'), false);
    assert.equal(isSafePublicUrl('http://[febf::1]/'), false);
    assert.equal(isSafePublicUrl('http://[fc00::1]/'), false);
    assert.equal(isSafePublicUrl('http://[fd12:3456::1]/'), false);
    assert.equal(isSafePublicUrl('http://[::ffff:127.0.0.1]/secret'), false);
    assert.equal(isSafePublicUrl('http://[::ffff:7f00:1]/secret'), false);
    assert.equal(isSafePublicUrl('http://[::ffff:169.254.169.254]/latest/meta-data'), false);
    assert.equal(isSafePublicUrl('http://[::ffff:a9fe:a9fe]/latest/meta-data'), false);
    assert.equal(isSafePublicUrl('http://[::ffff:10.0.0.1]/'), false);
    assert.equal(isSafePublicUrl('https://user:pass@example.com/a'), false);
    assert.equal(isSafePublicUrl('file:///etc/passwd'), false);
  });

  it('blocks SSRF redirects before fetching the private hop and enforces redirect cap', async () => {
    const originalFetch = globalThis.fetch;
    const seenUrls = [];
    globalThis.fetch = async (targetUrl) => {
      seenUrls.push(String(targetUrl));
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:8080/internal' }
      });
    };
    try {
      const result = await scrapeUrlStructured({ url: 'https://public.example/redirect' });
      assert.equal(result.quality, 'blocked');
      assert.match(result.error, /blocked redirect/i);
      assert.deepEqual(seenUrls, ['https://public.example/redirect']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts streamed responses that exceed maxDownloadBytes without buffering unboundedly', async () => {
    const originalFetch = globalThis.fetch;
    let chunksPulled = 0;
    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        pull(controller) {
          chunksPulled += 1;
          controller.enqueue(new Uint8Array(32 * 1024));
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      });
    };
    try {
      const result = await scrapeUrlStructured({
        url: 'https://public.example/huge.txt',
        maxDownloadBytes: 64 * 1024
      });
      assert.equal(result.quality, 'blocked');
      assert.match(result.error, /too large/i);
      assert.ok(chunksPulled <= 4, `expected early cancel, pulled ${chunksPulled} chunks`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('detects document kinds from type, path, and magic bytes', () => {
    assert.equal(detectDocumentKind('https://x.test/a.pdf', 'application/pdf'), 'pdf');
    assert.equal(
      detectDocumentKind(
        'https://x.test/report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ),
      'docx'
    );
    assert.equal(detectDocumentKind('https://x.test/page', 'text/html; charset=utf-8'), 'html');
    assert.equal(detectDocumentKind('https://x.test/notes.txt', 'text/plain'), 'text');
    assert.equal(detectDocumentKind('https://x.test/legacy.doc', 'application/msword'), 'unsupported-doc');

    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
    assert.equal(detectDocumentKind('https://x.test/blob', 'application/octet-stream', pdfMagic), 'pdf');
  });

  it('compacts extracted text for fewer tokens', () => {
    const raw = 'Hello   world\n\n\n\nNext   line\u0000';
    assert.equal(compactExtractedText(raw), 'Hello world\n\nNext line');
    assert.equal(compactExtractedText('x'.repeat(600), 100).length, 100);
  });

  it('normalizes absolute urls and drops fragments', () => {
    assert.equal(
      normalizeAbsoluteUrl('/docs/page/', 'https://example.com/base'),
      'https://example.com/docs/page'
    );
    assert.equal(
      normalizeAbsoluteUrl('https://example.com/a#section', 'https://example.com'),
      'https://example.com/a'
    );
    assert.equal(normalizeAbsoluteUrl('javascript:void(0)', 'https://example.com'), '');
  });

  it('extracts readable content with Readability and marks extraction mode', () => {
    const html = `<!doctype html>
<html>
  <head>
    <title>Fixture Title</title>
    <meta name="description" content="Fixture description for testing scrape." />
  </head>
  <body>
    <nav><a href="/ignored">Nav</a></nav>
    <article>
      <h1>Main Article</h1>
      <p>${'This is a substantial paragraph of article text for readability extraction. '.repeat(20)}</p>
      <p>Second paragraph with more detail about web scraping quality and context building.</p>
      <a href="/related/page">Related</a>
      <a href="https://other.test/out">External</a>
    </article>
  </body>
</html>`;

    const result = parseHtmlToReadable({
      html,
      url: 'https://site.test/article',
      maxLength: 20000,
      maxLinks: 20
    });

    assert.ok(result.content.length > 200, 'expected substantial content');
    assert.ok(result.title);
    assert.equal(result.quality, 'ok');
    assert.equal(result.document_kind, 'html');
    assert.ok(Array.isArray(result.links));
    assert.ok(result.links.some((link) => link.url.includes('/related/page')));
    assert.ok(result.links.some((link) => link.url === 'https://other.test/out'));
  });

  const prose = 'This sentence carries real article words for Reader View to score. '.repeat(12);

  it('keeps the spaces between words and renders article structure as markdown', () => {
    const html = `<!doctype html><html><head><title>Guide</title></head><body>
      <article>
        <h1>Guide</h1>
        <p>${prose}</p>
        <p>Install the tool with <code>cargo install</code> and <a href="/docs/run">run it</a> &amp; enjoy.</p>
        <h2>Options</h2>
        <ul><li>First <strong>option</strong></li><li>Second option</li></ul>
        <table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>depth</td><td>3</td></tr></tbody></table>
        <pre><code class="language-js">const a = 1;
  console.log(a);</code></pre>
        <p>${prose}</p>
      </article></body></html>`;
    const result = parseHtmlToReadable({ html, url: 'https://site.test/guide' });
    assert.equal(result.extraction, 'readability');
    assert.match(result.content, /Install the tool with `cargo install` and \[run it\]\(https:\/\/site\.test\/docs\/run\) & enjoy\./);
    assert.match(result.content, /## Options/);
    assert.match(result.content, /- First \*\*option\*\*\n- Second option/);
    assert.match(result.content, /\| Name \| Value \|\n\| --- \| --- \|\n\| depth \| 3 \|/);
    assert.match(result.content, /```js\nconst a = 1;\n {2}console\.log\(a\);\n```/);
  });

  it('returns the whole page with no length budget', () => {
    const long = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i}. ${prose}</p>`).join('');
    const result = parseHtmlToReadable({ html: `<html><body><article>${long}</article></body></html>`, url: 'https://site.test/long' });
    assert.ok(result.content.length > 200000, `got ${result.content.length}`);
    assert.match(result.content, /Paragraph 399\./);
    assert.equal(result.truncated, false);
  });

  it('falls back to the content region without scripts, styles, menus or hidden text', () => {
    const html = `<html><head><style>.x{color:red}</style></head><body>
      <header><nav><a href="/">Home</a><a href="/blog">Blog</a></nav></header>
      <div class="cookie-banner">We use cookies</div>
      <div class="layout"><div class="text">Short loose text in a div<div>and a nested line</div></div></div>
      <script>window.tracking = true;</script>
      <p style="display:none">Hidden promo</p>
      <footer>Privacy · Terms</footer></body></html>`;
    const result = parseHtmlToReadable({ html, url: 'https://site.test/x' });
    assert.match(result.content, /Short loose text in a div/);
    assert.match(result.content, /and a nested line/);
    for (const junk of ['color:red', 'tracking', 'cookies', 'Blog', 'Hidden promo', 'Privacy']) {
      assert.ok(!result.content.includes(junk), `${junk} leaked: ${result.content}`);
    }
  });
});
