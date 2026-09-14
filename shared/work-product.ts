// ── Work-product input vocabulary (main ⇄ renderer) ───────────────────
// The shapes that describe a generated document (report / spreadsheet) and the
// normalizers that coerce arbitrary model output into them.
//
// Both processes need this: the renderer validates and previews a document
// before asking for it, and main rebuilds the same structure when writing the
// file. It lives here rather than in two hand-synced copies because the copies
// had already drifted (the renderer's normalizer grew a `fallbackContent`
// argument that main's lacked).

export type SectionInput = {
  title?: string;
  heading?: string;
  content?: string;
  bullets?: string[];
  citations?: string[];
};

export type SheetInput = {
  name?: string;
  columns?: Array<string | { header?: string; key?: string; width?: number }>;
  rows?: Array<Record<string, unknown> | unknown[]>;
};

/** Trimmed string, with a fallback for nullish input. */
export function text(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim();
}

/** Escapes the five characters that break HTML attribute/text contexts. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Coerces unknown model output into usable sections, dropping empty ones.
 * `fallbackContent` synthesizes a single body section when no usable array is
 * supplied (a model that answered with prose instead of structure).
 */
export function normalizeSections(sections: unknown, fallbackContent?: string): SectionInput[] {
  if (!Array.isArray(sections)) {
    return fallbackContent ? [{ content: fallbackContent }] : [];
  }
  return sections.map((section) => {
    if (typeof section === 'string') return { content: section };
    const item = (section && typeof section === 'object') ? section as Record<string, unknown> : {};
    return {
      title: text(item.title),
      heading: text(item.heading),
      content: text(item.content),
      bullets: Array.isArray(item.bullets) ? item.bullets.map((bullet) => text(bullet)).filter(Boolean) : [],
      citations: Array.isArray(item.citations) ? item.citations.map((citation) => text(citation)).filter(Boolean) : []
    };
  }).filter((section) => section.title || section.heading || section.content || section.bullets?.length);
}
