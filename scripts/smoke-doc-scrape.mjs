#!/usr/bin/env node
import { isSafePublicUrl, scrapeUrlStructured } from '../main/web-scraper.ts';

async function main() {
  console.log('ssrf localhost blocked:', !isSafePublicUrl('http://127.0.0.1'));

  const pdf = await scrapeUrlStructured({
    url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    maxLength: 5000,
    timeoutMs: 20000
  });
  console.log('pdf', {
    error: pdf.error,
    quality: pdf.quality,
    kind: pdf.document_kind,
    len: pdf.length,
    title: pdf.title,
    excerpt: String(pdf.excerpt || '').slice(0, 100)
  });
  if (pdf.error && !pdf.content) throw new Error(`PDF scrape failed: ${pdf.error}`);

  const wiki = await scrapeUrlStructured({
    url: 'https://en.wikipedia.org/wiki/Web_scraping',
    maxLength: 8000,
    timeoutMs: 20000,
    maxLinks: 10
  });
  console.log('html', {
    quality: wiki.quality,
    kind: wiki.document_kind,
    extraction: wiki.extraction,
    len: wiki.length,
    links: wiki.links?.length
  });
  if (wiki.quality === 'blocked' && !wiki.content) throw new Error('HTML scrape failed');

  console.log('\nDoc scrape smoke OK');
}

main().catch((err) => {
  console.error('FAILED', err?.message || err);
  process.exitCode = 1;
});
