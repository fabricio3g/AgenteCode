import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafePublicUrl,
  classifyScrapeQuality,
  compactExtractedText,
  detectDocumentKind,
  isHttpUrl,
  isSafePublicUrl,
  normalizeAbsoluteUrl,
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
    assert.equal(isSafePublicUrl('http://localhost./'), false);
    assert.equal(isSafePublicUrl('http://app.localhost./'), false);
    assert.equal(isSafePublicUrl('http://foo.local./'), false);
    assert.equal(isSafePublicUrl('http://meta.internal./'), false);
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

  it('blocks DNS-rebinding hosts that resolve to loopback or private IPs', async () => {
    const loopbackLookup = async () => [{ address: '127.0.0.1', family: 4 }];
    const privateV6Lookup = async () => [{ address: '::1', family: 6 }];
    const mixedLookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 }
    ];
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

    assert.equal(await assertSafePublicUrl('https://rebind.example/a', loopbackLookup), false);
    assert.equal(await assertSafePublicUrl('https://rebind.example/a', privateV6Lookup), false);
    assert.equal(await assertSafePublicUrl('https://rebind.example/a', mixedLookup), false);
    assert.equal(await assertSafePublicUrl('https://rebind.example/a', publicLookup), true);
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
});
