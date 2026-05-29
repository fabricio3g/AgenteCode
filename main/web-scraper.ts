import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_LENGTH = 50000;
const DEFAULT_MAX_LINKS = 120;
const THIN_CONTENT_CHARS = 700;

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(num, max));
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanText(text) {
  return String(text || '').replace(/\u0000/g, '').trim();
}

function classifyScrapeQuality({ status = 0, content = '', error = '', title = '' } = {}) {
  const textLength = normalizeWhitespace(content).length;
  const message = String(error || '').toLowerCase();
  if (status === 401 || status === 403 || status === 429 || message.includes('forbidden') || message.includes('unauthorized')) {
    return {
      quality: 'blocked',
      warning: `Page could not be read cleanly (${error || `HTTP ${status}`}).`
    };
  }
  if (!error && textLength > 0 && textLength < THIN_CONTENT_CHARS) {
    return {
      quality: 'thin_content',
      warning: `Only ${textLength} characters could be extracted from ${title || 'the page'}. The site may rely on scripts or restrict scraping.`
    };
  }
  if (error) {
    return {
      quality: 'blocked',
      warning: error
    };
  }
  return { quality: 'ok', warning: '' };
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeAbsoluteUrl(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return '';
  }
}

function metaContent(document, selector) {
  return normalizeWhitespace(document.querySelector(selector)?.getAttribute('content') || '');
}

function extractMeta(document) {
  const title =
    metaContent(document, 'meta[property="og:title"]')
    || metaContent(document, 'meta[name="twitter:title"]')
    || normalizeWhitespace(document.querySelector('title')?.textContent || '');

  const description =
    metaContent(document, 'meta[property="og:description"]')
    || metaContent(document, 'meta[name="description"]')
    || metaContent(document, 'meta[name="twitter:description"]');

  const siteName =
    metaContent(document, 'meta[property="og:site_name"]')
    || normalizeWhitespace(document.querySelector('meta[name="application-name"]')?.getAttribute('content') || '');

  const ogImage =
    metaContent(document, 'meta[property="og:image"]')
    || metaContent(document, 'meta[name="twitter:image"]');

  return {
    title,
    description,
    site_name: siteName,
    og_image: ogImage
  };
}

function extractLinks(document, baseUrl, maxLinks = DEFAULT_MAX_LINKS) {
  const links = [];
  const seen = new Set();
  const baseHost = (() => {
    try {
      return new URL(baseUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  })();

  for (const anchor of document.querySelectorAll('a[href]')) {
    if (links.length >= maxLinks) break;
    const href = String(anchor.getAttribute('href') || '').trim();
    if (!href || href.startsWith('#')) continue;
    if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;

    const absolute = normalizeAbsoluteUrl(href, baseUrl);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);

    let url;
    try {
      url = new URL(absolute);
    } catch {
      continue;
    }

    const domain = url.hostname.replace(/^www\./, '').toLowerCase();
    links.push({
      text: normalizeWhitespace(anchor.textContent || '') || domain,
      url: absolute,
      domain,
      sameSite: !!baseHost && domain === baseHost
    });
  }

  return links;
}

function parseHtmlToReadable({ html, url, maxLength = DEFAULT_MAX_LENGTH, maxLinks = DEFAULT_MAX_LINKS }) {
  const safeMaxLength = clampNumber(maxLength, 1000, 200000, DEFAULT_MAX_LENGTH);
  const safeMaxLinks = clampNumber(maxLinks, 10, 300, DEFAULT_MAX_LINKS);
  const { document } = parseHTML(String(html || ''));

  const links = extractLinks(document, url, safeMaxLinks);
  const metadata = extractMeta(document);

  let article = null;
  try {
    const reader = new Readability(document, {
      keepClasses: false,
      charThreshold: 120
    });
    article = reader.parse();
  } catch {
    article = null;
  }

  const bodyText = cleanText(document.body?.textContent || '');
  const rawContent = cleanText(article?.textContent || bodyText);
  const content = rawContent.slice(0, safeMaxLength);
  const title =
    normalizeWhitespace(article?.title || '')
    || metadata.title
    || normalizeWhitespace(document.querySelector('title')?.textContent || '')
    || url;
  const excerpt =
    normalizeWhitespace(article?.excerpt || '')
    || metadata.description
    || content.slice(0, 280);

  const result = {
    url,
    title,
    excerpt,
    content,
    links,
    site_name: metadata.site_name || normalizeWhitespace(article?.siteName || ''),
    og_image: metadata.og_image,
    length: content.length,
    warning: article ? undefined : 'Readability could not identify a clean article; returned body text fallback.'
  };
  const quality = classifyScrapeQuality(result);
  return {
    ...result,
    quality: quality.quality,
    warning: quality.warning || result.warning
  };
}

function buildReaderFallbackUrl(url) {
  try {
    const target = new URL(url);
    return `https://r.jina.ai/http://${target.host}${target.pathname}${target.search}`;
  } catch {
    return '';
  }
}

async function fetchReaderFallback(url, maxLength, timeoutMs) {
  const readerUrl = buildReaderFallbackUrl(url);
  if (!readerUrl) return null;
  try {
    const response = await fetch(readerUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'text/plain',
        'X-Return-Format': 'markdown',
        'User-Agent': 'Chatea/1.0'
      }
    });
    if (!response.ok) return null;
    const content = cleanText(await response.text()).slice(0, maxLength);
    if (!content) return null;
    return {
      url,
      status: response.status,
      title: url,
      excerpt: content.slice(0, 280),
      content,
      links: [],
      site_name: '',
      og_image: '',
      length: content.length,
      quality: content.length < THIN_CONTENT_CHARS ? 'thin_content' : 'ok',
      warning: 'Primary extraction was limited; used reader fallback.'
    };
  } catch {
    return null;
  }
}

export async function scrapeUrlStructured({ url, maxLength, timeoutMs, maxLinks } = {}) {
  const normalizedUrl = String(url || '').trim();
  if (!isHttpUrl(normalizedUrl)) {
    return { error: 'Invalid URL. Only http/https URLs are supported.' };
  }

  const safeTimeout = clampNumber(timeoutMs, 1000, 60000, DEFAULT_TIMEOUT_MS);
  const safeMaxLength = clampNumber(maxLength, 1000, 200000, DEFAULT_MAX_LENGTH);
  let response;
  try {
    response = await fetch(normalizedUrl, {
      signal: AbortSignal.timeout(safeTimeout),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Chatea/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'
      }
    });
  } catch (error) {
    return {
      error: error?.message || String(error || 'Request failed'),
      url: normalizedUrl,
      status: 0
    };
  }

  if (!response.ok) {
    const error = `HTTP ${response.status}`;
    const quality = classifyScrapeQuality({ status: response.status, error });
    const fallback = await fetchReaderFallback(normalizedUrl, safeMaxLength, Math.min(safeTimeout, 20000));
    if (fallback) return fallback;
    return { error, status: response.status, url: normalizedUrl, quality: quality.quality, warning: quality.warning };
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const body = await response.text();

  if (!contentType.includes('html')) {
    const plainText = cleanText(body).slice(0, safeMaxLength);
    const result = {
      url: normalizedUrl,
      status: response.status,
      title: normalizedUrl,
      excerpt: plainText.slice(0, 280),
      content: plainText,
      links: [],
      site_name: '',
      og_image: '',
      length: plainText.length
    };
    const quality = classifyScrapeQuality(result);
    return { ...result, quality: quality.quality, warning: quality.warning };
  }

  const parsed = parseHtmlToReadable({
    html: body,
    url: normalizedUrl,
    maxLength: safeMaxLength,
    maxLinks
  });

  const finalResult = {
    ...parsed,
    status: response.status,
    truncated: parsed.length >= safeMaxLength
  };
  if (finalResult.quality !== 'ok') {
    const fallback = await fetchReaderFallback(normalizedUrl, safeMaxLength, Math.min(safeTimeout, 20000));
    if (fallback && fallback.content.length > finalResult.content.length) return fallback;
  }
  return finalResult;
}
