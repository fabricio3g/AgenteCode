export interface SlugifyOptions {
  /** Fallback string when the input produces an empty slug. */
  fallback?: string;
  /** Maximum length of the returned slug (trailing hyphens stripped after slicing). */
  maxLength?: number;
  /** Normalize Unicode accents (NFKD + strip combining marks) before slugifying. */
  normalizeUnicode?: boolean;
}

/** Convert arbitrary text into a lowercase, hyphen-separated URL/filename slug. */
export function toSlug(input: unknown, options: SlugifyOptions = {}): string {
  const raw = typeof input === 'string' ? input : input == null ? '' : String(input);
  const normalized = options.normalizeUnicode
    ? raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    : raw;
  let slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (options.maxLength && slug.length > options.maxLength) {
    slug = slug.slice(0, options.maxLength).replace(/-+$/g, '');
  }
  return slug || (options.fallback ?? '');
}
