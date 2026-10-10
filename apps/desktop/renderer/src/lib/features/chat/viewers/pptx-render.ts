// A .pptx file drawn slide by slide. @office-kit/pptx parses the deck and
// @office-kit/pptx-preview (both MIT) lays each slide out as SVG from the
// file's own shapes, text, images, tables, charts and theme, so a deck looks
// like it does in PowerPoint rather than like a re-typed outline.

import { readArrayBuffer } from './viewer-source';

export interface RenderedSlide {
  /** Object URL of the slide's SVG; shown through <img>, so nothing in it runs. */
  url: string;
  title: string;
  notes: string;
  text: string;
}

export interface RenderedDeck {
  slides: RenderedSlide[];
  /** Width ÷ height of the slide canvas (16:9 → 1.777…). */
  aspect: number;
  /** Revokes the slide URLs; call when the deck is no longer shown. */
  dispose: () => void;
}

export async function renderPptx(source: string): Promise<RenderedDeck> {
  const [{ loadPresentation, getSlides, getSlideNotes, getSlideTitle, getSlideSize }, { renderSlideToSvg }] = await Promise.all([
    import('@office-kit/pptx'),
    import('@office-kit/pptx-preview')
  ]);
  const bytes = new Uint8Array(await readArrayBuffer(source, 'presentation'));
  const pres = await loadPresentation(bytes);
  const size = getSlideSize(pres) as { width?: number; height?: number; cx?: number; cy?: number } | null;
  const width = Number(size?.width ?? size?.cx) || 16;
  const height = Number(size?.height ?? size?.cy) || 9;
  const urls: string[] = [];
  const slides = getSlides(pres).map((slide) => {
    // Give the SVG an intrinsic size so <img> rasterizes it crisply.
    const svg = renderSlideToSvg(pres, slide).replace(/^<svg /, '<svg width="1920" height="' + Math.round(1920 / (width / height)) + '" ');
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    urls.push(url);
    const text = [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')].map((node) => node.textContent || '').join('\n');
    return { url, title: getSlideTitle(slide) || '', notes: (getSlideNotes(slide) || '').trim(), text };
  });
  return {
    slides,
    aspect: width / height,
    dispose: () => urls.forEach((url) => URL.revokeObjectURL(url))
  };
}
