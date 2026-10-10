import type { ChartData } from '$lib/utils/chart-data';
import type { ChartType } from '$lib/utils/chart-types';

export interface TipRow { label: string; value: number; color: string }
export interface ChartScene {
  svg: SVGSVGElement;
  data: ChartData;
  type: ChartType;
  width: number;
  height: number;
  colors: string[];
  surface: string;
  foreground: string;
  muted: string;
  grid: string;
  font: string;
  fontSize: number;
  format: (value: number) => string;
  tip: (event: PointerEvent, title: string, rows: TipRow[]) => void;
  hide: () => void;
}

export function node<K extends keyof SVGElementTagNameMap>(parent: SVGElement, tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}

export function label(scene: ChartScene, parent: SVGElement, x: number, y: number, text: string, anchor = 'middle') {
  return node(parent, 'text', { x, y, fill: scene.muted, 'font-family': scene.font, 'font-size': scene.fontSize, 'text-anchor': anchor, 'pointer-events': 'none' }, text);
}

export function mark(scene: ChartScene, el: SVGElement, title: string, rows: TipRow[]) {
  node(el, 'title', {}, `${title}: ${rows.map((r) => `${r.label} ${scene.format(r.value)}`).join(', ')}`);
  el.addEventListener('pointermove', (event) => scene.tip(event, title, rows));
  el.addEventListener('pointerleave', scene.hide);
}

export function short(value: string, length = 13) { return value.length > length ? `${value.slice(0, length - 1)}…` : value; }
export function color(scene: ChartScene, index: number) { return scene.colors[index % scene.colors.length]; }
