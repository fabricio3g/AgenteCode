// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { CHART_TYPES } from '$lib/utils/chart-types';
import { drawCartesian } from './chart-cartesian';
import { drawSpecial } from './chart-special';
import type { ChartScene } from './chart-scene';
const special = ['pie', 'donut', 'heatmap', 'radar', 'funnel', 'treemap', 'gauge'];
function scene(type: ChartScene['type']): ChartScene {
  return { svg: document.createElementNS('http://www.w3.org/2000/svg', 'svg'), type, width: 600, height: 280,
    data: { labels: ['1', '2', '3', '4'], datasets: [{ label: 'A', data: [10, 20, 15, 30], sizes: [1, 2, 3, 4] }, { label: 'B', data: [4, 8, 12, 16] }] },
    colors: ['#2563eb', '#059669', '#d97706', '#dc2626'], surface: '#fff', foreground: '#111', muted: '#666', grid: '#ddd', font: 'Inter', fontSize: 12,
    format: (v) => String(v), tip: vi.fn(), hide: vi.fn() };
}
describe('native chart catalog', () => {
  it.each(CHART_TYPES)('draws %s without invalid geometry at narrow and wide widths', (type) => {
    for (const width of [260, 760]) {
      const s = scene(type); s.width = width;
      (special.includes(type) ? drawSpecial : drawCartesian)(s);
      expect(s.svg.childElementCount).toBeGreaterThan(0);
      expect(s.svg.innerHTML).not.toMatch(/NaN|Infinity|undefined/);
      for (const rect of s.svg.querySelectorAll('rect')) {
        expect(Number(rect.getAttribute('width'))).toBeGreaterThanOrEqual(0);
        expect(Number(rect.getAttribute('height'))).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it('keeps repeated values attached to their own label', () => {
    const s = scene('bar'); s.data = { labels: ['First', 'Second'], datasets: [{ label: 'A', data: [10, 10] }] };
    drawCartesian(s);
    const bars = s.svg.querySelectorAll('rect');
    bars[1].dispatchEvent(new MouseEvent('pointermove'));
    expect(s.tip).toHaveBeenCalledWith(expect.anything(), 'Second', expect.anything());
    expect(bars[0].getAttribute('x')).not.toBe(bars[1].getAttribute('x'));
  });
  it('draws negative bars on opposite sides of zero', () => {
    const s = scene('bar'); s.data = { labels: ['Loss', 'Gain'], datasets: [{ label: 'Change', data: [-10, 10] }] };
    drawCartesian(s);
    const bars = [...s.svg.querySelectorAll('rect')];
    expect(bars.every((bar) => Number(bar.getAttribute('height')) > 0)).toBe(true);
    expect(Number(bars[0].getAttribute('y'))).toBeGreaterThan(Number(bars[1].getAttribute('y')));
  });
});
