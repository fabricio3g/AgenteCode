import type { PresentationData, SlideData } from '$lib/types/tauri';
import { invoke } from './tauri';

export async function generatePptx(data: PresentationData): Promise<number[]> {
  return invoke<number[]>('generate_pptx', { data });
}

export async function savePptx(data: PresentationData, path: string): Promise<void> {
  await invoke<void>('save_pptx', { data, path });
}

export async function parseSlidesFromMarkdown(markdown: string): Promise<SlideData[]> {
  return invoke<SlideData[]>('parse_slides_from_markdown', { markdown });
}

export async function slidesToMarkdown(slides: SlideData[]): Promise<string> {
  return invoke<string>('slides_to_markdown', { slides });
}
