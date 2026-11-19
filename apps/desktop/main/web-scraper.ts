import { APP_USER_AGENT } from '../shared/brand.ts';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { normalizeWhitespace, cleanText } from './search-providers/shared.ts';
import { elementToMarkdown, pickContentRoot, removeNoise } from './html-markdown.ts';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_LINKS = 120;
/** Sites answer an unknown agent with a bot wall; ask the way a browser does. */
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const THIN_CONTENT_CHARS = 700;
/** Cap remote binary downloads (PDF/DOCX) to reduce abuse risk. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const HARD_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(num, max));
}

/** A caller's character limit, or undefined: the whole text (the default). */
function optionalLimit(value) {
  if (value == null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.max(64, Math.floor(num)) : undefined;
}

/**
 * Collapse runs of spaces, blank lines and NULs in text pulled out of a PDF,
 * Word file or plain-text page. The whole text is kept unless the caller
 * passes its own `maxLength`.
 */
export function compactExtractedText(text, maxLength = undefined) {
  const limit = optionalLimit(maxLength);
  const compact = cleanText(String(text || ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return limit ? compact.slice(0, limit) : compact;
}

function isPrivateOrLocalIpv4(hostname) {
  const m = String(hostname || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Public http(s) only — blocks SSRF to localhost, private nets, file/data schemes, and credentials-in-URL.
 */
export function isSafePublicUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      return false;
    }
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return false;
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false; // ULA / link-local v6
    if (isPrivateOrLocalIpv4(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export function detectDocumentKind(url = '', contentType = '', magicBytes = null) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  const path = (() => {
    try {
      return new URL(String(url || '')).pathname.toLowerCase();
    } catch {
      return String(url || '').toLowerCase();
    }
  })();

  // Magic-byte sniff for mislabeled downloads
  if (magicBytes && magicBytes.byteLength >= 5) {
    const u8 = magicBytes instanceof Uint8Array ? magicBytes : new Uint8Array(magicBytes);
    // %PDF-
    if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'pdf';
    // PK.. zip (docx is a zip package)
    if (u8[0] === 0x50 && u8[1] === 0x4b && (path.endsWith('.docx') || ct.includes('wordprocessingml') || ct.includes('officedocument'))) {
      return 'docx';
    }
  }

  if (ct.includes('application/pdf') || path.endsWith('.pdf')) return 'pdf';
  if (
    ct.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    || ct.includes('application/vnd.ms-word.document.macroenabled')
    || path.endsWith('.docx')
  ) {
    return 'docx';
  }
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return 'html';
  if (
    ct.startsWith('text/')
    || ct.includes('application/json')
    || ct.includes('application/xml')
    || path.endsWith('.txt')
    || path.endsWith('.md')
    || path.endsWith('.csv')
    || path.endsWith('.json')
  ) {
    return 'text';
  }
  if (ct.includes('octet-stream') || !ct) {
    if (path.endsWith('.pdf')) return 'pdf';
    if (path.endsWith('.docx')) return 'docx';
    if (path.endsWith('.html') || path.endsWith('.htm')) return 'html';
  }
  // legacy .doc is not safely parsed here
  if (path.endsWith('.doc') || ct.includes('application/msword')) return 'unsupported-doc';
  return ct.includes('html') ? 'html' : 'unknown';
}

function filenameFromUrl(url) {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return base || url;
  } catch {
    return url;
  }
}

function hasUsableExtractedText(text) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length < 80) return false;
  const wordMatches = normalized.match(/[\p{L}\p{N}]{2,}/gu) || [];
  return wordMatches.length >= 20;
}

async function extractPdfTextFromBuffer(buffer, maxLength = undefined) {
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(Buffer.from(buffer));
  const text = compactExtractedText(data?.text || '', maxLength);
  if (!text) {
    throw new Error('PDF parser returned no readable text (may be scanned/image-only)');
  }
  return {
    text,
    title: normalizeWhitespace(data?.info?.Title || '') || '',
    pages: Number(data?.numpages) || undefined,
    thin: !hasUsableExtractedText(text)
  };
}

async function extractDocxTextFromBuffer(buffer, maxLength = undefined) {
  const mammoth = await import('mammoth');
  const extract = mammoth.default?.extractRawText || mammoth.extractRawText;
  const result = await extract({ buffer: Buffer.from(buffer) });
  const text = compactExtractedText(result?.value || '', maxLength);
  if (!text) {
    throw new Error('DOCX parser returned no readable text');
  }
  return { text, title: '', pages: undefined, thin: !hasUsableExtractedText(text) };
}

function documentResult({
  url,
  status,
  title,
  content,
  kind,
  maxLength,
  warning = '',
  pages
}) {
  const text = compactExtractedText(content, maxLength);
  const result = {
    url,
    status,
    title: title || filenameFromUrl(url),
    excerpt: text.slice(0, 280),
    content: text,
    links: [],
    site_name: '',
    og_image: '',
    length: text.length,
    document_kind: kind,
    pages,
    truncated: !!optionalLimit(maxLength) && text.length >= optionalLimit(maxLength)
  };
  const quality = classifyScrapeQuality({ ...result, warning });
  return {
    ...result,
    quality: quality.quality,
    warning: quality.warning || warning || undefined
  };
}

export function classifyScrapeQuality({ status = 0, content = '', error = '', title = '' } = {}) {
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

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeAbsoluteUrl(href, baseUrl) {
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

  // Bibliographic fields for APA-style references (never invent — only page metadata).
  const author =
    metaContent(document, 'meta[name="author"]')
    || metaContent(document, 'meta[property="article:author"]')
    || metaContent(document, 'meta[name="byl"]')
    || metaContent(document, 'meta[name="sailthru.author"]')
    || normalizeWhitespace(document.querySelector('[rel="author"]')?.textContent || '')
    || normalizeWhitespace(document.querySelector('.author, .byline, [itemprop="author"]')?.textContent || '');

  const published_at =
    metaContent(document, 'meta[property="article:published_time"]')
    || metaContent(document, 'meta[name="article:published_time"]')
    || metaContent(document, 'meta[name="date"]')
    || metaContent(document, 'meta[name="publish-date"]')
    || metaContent(document, 'meta[name="pubdate"]')
    || metaContent(document, 'meta[itemprop="datePublished"]')
    || normalizeWhitespace(document.querySelector('time[datetime]')?.getAttribute('datetime') || '')
    || normalizeWhitespace(document.querySelector('time')?.textContent || '');

  return {
    title,
    description,
    site_name: siteName,
    og_image: ogImage,
    author: author.slice(0, 200),
    published_at: published_at.slice(0, 80)
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

/**
 * A page as readable markdown: Mozilla Readability (Firefox's Reader View)
 * finds the article, `html-markdown.ts` renders it — headings, lists, tables,
 * code and links, with the spaces between words kept. When Readability finds
 * no article, the page's own content region is read instead, with menus,
 * banners and hidden text removed — never the raw text of the whole body,
 * which carried scripts, styles and navigation. The whole text is returned
 * unless the caller passes `maxLength`.
 */
export function parseHtmlToReadable({ html, url, maxLength = undefined, maxLinks = DEFAULT_MAX_LINKS }) {
  const limit = optionalLimit(maxLength);
  const safeMaxLinks = clampNumber(maxLinks, 10, 300, DEFAULT_MAX_LINKS);
  const source = String(html || '');
  const { document } = parseHTML(source);

  const links = extractLinks(document, url, safeMaxLinks);
  const metadata = extractMeta(document);
  removeNoise(document);

  let article = null;
  try {
    const reader = new Readability(document, {
      // Classes carry code languages (`language-js`) and mark share bars and
      // promos the renderer still drops inside an article.
      keepClasses: true,
      charThreshold: 120
    });
    article = reader.parse();
  } catch {
    article = null;
  }

  let rawContent = '';
  let extraction = 'readability';
  if (article?.content) {
    const { document: articleDocument } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
    rawContent = articleDocument.body ? elementToMarkdown(articleDocument.body, url) : '';
  }
  if (rawContent.length < THIN_CONTENT_CHARS) {
    // Readability rewrites the document it parses, so the fallback reads a fresh copy.
    const { document: copy } = parseHTML(source);
    removeNoise(copy);
    const root = pickContentRoot(copy);
    const fallback = root ? elementToMarkdown(root, url) : '';
    if (fallback.length > rawContent.length) {
      rawContent = fallback;
      extraction = 'fallback';
    }
  }

  const whole = cleanText(rawContent).replace(/\n{3,}/g, '\n\n').trim();
  const content = limit ? whole.slice(0, limit) : whole;
  const title =
    normalizeWhitespace(article?.title || '')
    || metadata.title
    || url;
  const excerpt =
    normalizeWhitespace(article?.excerpt || '')
    || metadata.description
    || normalizeWhitespace(content.slice(0, 280));

  const result = {
    url,
    title,
    excerpt,
    content,
    links,
    site_name: metadata.site_name || normalizeWhitespace(article?.siteName || ''),
    og_image: metadata.og_image,
    author: metadata.author || '',
    published_at: metadata.published_at || '',
    length: content.length,
    truncated: content.length < whole.length,
    document_kind: 'html',
    extraction,
    warning: extraction === 'fallback'
      ? 'Reader View found no article on this page; its main region was read instead.'
      : undefined
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
  if (!isSafePublicUrl(url)) return null;
  const readerUrl = buildReaderFallbackUrl(url);
  if (!readerUrl) return null;
  try {
    const response = await fetch(readerUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'text/plain',
        'X-Return-Format': 'markdown',
        'User-Agent': APP_USER_AGENT
      }
    });
    if (!response.ok) return null;
    const content = compactExtractedText(await response.text(), maxLength);
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
      document_kind: 'html',
      extraction: 'reader_fallback',
      quality: content.length < THIN_CONTENT_CHARS ? 'thin_content' : 'ok',
      warning: 'Primary extraction was limited; used reader fallback.'
    };
  } catch {
    return null;
  }
}

export async function scrapeUrlStructured({
  url,
  maxLength,
  timeoutMs,
  maxLinks,
  maxDownloadBytes
} = {}) {
  const normalizedUrl = String(url || '').trim();
  if (!isSafePublicUrl(normalizedUrl)) {
    return {
      error: 'Invalid or blocked URL. Only public http/https URLs are allowed (no localhost/private networks).',
      url: normalizedUrl,
      status: 0,
      quality: 'blocked'
    };
  }

  const safeTimeout = clampNumber(timeoutMs, 1000, 60000, DEFAULT_TIMEOUT_MS);
  // No length budget unless the caller sets one: the page comes back whole.
  const safeMaxLength = optionalLimit(maxLength);
  const safeMaxDownload = clampNumber(
    maxDownloadBytes,
    64 * 1024,
    HARD_MAX_DOWNLOAD_BYTES,
    DEFAULT_MAX_DOWNLOAD_BYTES
  );

  let response;
  try {
    response = await fetch(normalizedUrl, {
      signal: AbortSignal.timeout(safeTimeout),
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain;q=0.9,*/*;q=0.8'
      }
    });
  } catch (error) {
    return {
      error: error?.message || String(error || 'Request failed'),
      url: normalizedUrl,
      status: 0
    };
  }

  // Reject redirects that land on private/non-public targets (SSRF via redirect).
  const finalUrl = String(response.url || normalizedUrl);
  if (!isSafePublicUrl(finalUrl)) {
    return {
      error: 'Blocked redirect to a non-public or unsafe URL.',
      url: normalizedUrl,
      status: response.status,
      quality: 'blocked'
    };
  }

  if (!response.ok) {
    const error = `HTTP ${response.status}`;
    const quality = classifyScrapeQuality({ status: response.status, error });
    // Reader fallback only for HTML-ish pages, not binary document URLs
    const kindGuess = detectDocumentKind(finalUrl, response.headers.get('content-type') || '');
    if (kindGuess === 'html' || kindGuess === 'unknown' || kindGuess === 'text') {
      const fallback = await fetchReaderFallback(finalUrl, safeMaxLength, Math.min(safeTimeout, 20000));
      if (fallback) return fallback;
    }
    return { error, status: response.status, url: finalUrl, quality: quality.quality, warning: quality.warning };
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const contentLengthHeader = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLengthHeader) && contentLengthHeader > safeMaxDownload) {
    return {
      error: `Remote file too large (${contentLengthHeader} bytes; max ${safeMaxDownload}).`,
      url: finalUrl,
      status: response.status,
      quality: 'blocked'
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > safeMaxDownload) {
    return {
      error: `Downloaded payload too large (${arrayBuffer.byteLength} bytes; max ${safeMaxDownload}).`,
      url: finalUrl,
      status: response.status,
      quality: 'blocked'
    };
  }

  const magic = new Uint8Array(arrayBuffer, 0, Math.min(16, arrayBuffer.byteLength));
  const kind = detectDocumentKind(finalUrl, contentType, magic);

  if (kind === 'pdf') {
    try {
      const extracted = await extractPdfTextFromBuffer(arrayBuffer, safeMaxLength);
      return documentResult({
        url: finalUrl,
        status: response.status,
        title: extracted.title || filenameFromUrl(finalUrl),
        content: extracted.text,
        kind: 'pdf',
        maxLength: safeMaxLength,
        pages: extracted.pages,
        warning: extracted.thin
          ? 'PDF text is short; the file may be mostly images or a stub document.'
          : ''
      });
    } catch (error) {
      return {
        error: error?.message || 'Failed to extract text from PDF',
        url: finalUrl,
        status: response.status,
        document_kind: 'pdf',
        quality: 'blocked'
      };
    }
  }

  if (kind === 'docx') {
    try {
      const extracted = await extractDocxTextFromBuffer(arrayBuffer, safeMaxLength);
      return documentResult({
        url: finalUrl,
        status: response.status,
        title: filenameFromUrl(finalUrl),
        content: extracted.text,
        kind: 'docx',
        maxLength: safeMaxLength,
        warning: extracted.thin
          ? 'Word document text is short or sparse.'
          : ''
      });
    } catch (error) {
      return {
        error: error?.message || 'Failed to extract text from Word document',
        url: finalUrl,
        status: response.status,
        document_kind: 'docx',
        quality: 'blocked'
      };
    }
  }

  if (kind === 'unsupported-doc') {
    return {
      error: 'Legacy .doc Word format is not supported. Use .docx or PDF.',
      url: finalUrl,
      status: response.status,
      document_kind: 'doc',
      quality: 'blocked'
    };
  }

  // Decode text/html (and plain text) from bytes — UTF-8 with fallback label from header
  const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
  const charset = charsetMatch?.[1] || 'utf-8';
  let bodyText = '';
  try {
    bodyText = new TextDecoder(charset, { fatal: false }).decode(arrayBuffer);
  } catch {
    bodyText = new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
  }

  if (kind === 'text') {
    return documentResult({
      url: finalUrl,
      status: response.status,
      title: filenameFromUrl(finalUrl),
      content: bodyText,
      kind: 'text',
      maxLength: safeMaxLength
    });
  }

  if (kind !== 'html' && kind !== 'unknown') {
    return {
      error: `Unsupported content type for extraction: ${contentType || kind}`,
      url: finalUrl,
      status: response.status,
      document_kind: kind,
      quality: 'blocked'
    };
  }

  // HTML: Mozilla Readability article extraction (token-efficient)
  const parsed = parseHtmlToReadable({
    html: bodyText,
    url: finalUrl,
    maxLength: safeMaxLength,
    maxLinks
  });

  const finalResult = {
    ...parsed,
    url: finalUrl,
    status: response.status
  };
  if (finalResult.quality !== 'ok') {
    const fallback = await fetchReaderFallback(finalUrl, safeMaxLength, Math.min(safeTimeout, 20000));
    if (fallback && fallback.content.length > finalResult.content.length) return fallback;
  }
  return finalResult;
}
