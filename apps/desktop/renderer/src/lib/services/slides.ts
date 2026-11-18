import type { PresentationData, SlideData } from '$lib/types/bridge';
import { invoke } from './bridge';

export async function generatePptx(data: PresentationData): Promise<number[]> {
  return invoke<number[]>('generate_pptx', { data });
}

export async function parseSlidesFromMarkdown(markdown: string): Promise<SlideData[]> {
  return invoke<SlideData[]>('parse_slides_from_markdown', { markdown });
}
