import { arc, pie, line, curveLinearClosed } from 'd3-shape';
import type { PieArcDatum } from 'd3-shape';
import { node, label, mark, color, short, type ChartScene } from './chart-scene';

export function drawSpecial(s: ChartScene) {
  if (s.type === 'heatmap') return heatmap(s);
  if (s.type === 'radar') return radar(s);
  if (s.type === 'funnel') return funnel(s);
  if (s.type === 'treemap') return treemap(s);
  if (s.type === 'gauge') return gauge(s);
  const values = s.data.datasets[0].data;
  const total = values.reduce((sum, v) => sum + v, 0);
  const radius = Math.min(s.width / 2 - 16, s.height / 2 - 18);
  const g = node(s.svg, 'g', { transform: `translate(${s.width / 2},${s.height / 2})` });
  const generator = arc<PieArcDatum<number>>().innerRadius(s.type === 'donut' ? radius * .7 : 0).outerRadius(radius).padAngle(.018).cornerRadius(2);
  pie<number>().sort(null)(values).forEach((slice, i) => {
    const el = node(g, 'path', { d: generator(slice) ?? '', fill: color(s, i) });
    mark(s, el, s.data.labels[i], [{ label: s.data.datasets[0].label, value: values[i], color: color(s, i) }, { label: 'Share (%)', value: values[i] / total * 100, color: color(s, i) }]);
  });
  if (s.type === 'donut') {
    node(g, 'text', { x: 0, y: 0, fill: s.foreground, 'font-family': s.font, 'font-size': 26, 'font-weight': 600, 'text-anchor': 'middle' }, s.format(total));
    label(s, g, 0, 23, 'Total');
  }
}

function heatmap(s: ChartScene) {
  const left = Math.min(104, s.width * .27), w = s.width - left - 8, h = s.height - 54;
  const cw = w / s.data.labels.length, ch = h / s.data.datasets.length;
  const all = s.data.datasets.flatMap((ds) => ds.data), min = Math.min(0, ...all), max = Math.max(...all);
  const every = Math.max(1, Math.ceil(s.data.labels.length / Math.max(2, Math.floor(w / 60))));
  s.data.labels.forEach((name, i) => { if (!(i % every)) label(s, s.svg, left + cw * (i + .5), h + 23, short(name, 8)); });
  s.data.datasets.forEach((ds, row) => {
    label(s, s.svg, left - 8, ch * (row + .5) + 4, short(ds.label, 13), 'end');
    ds.data.forEach((v, col) => {
      const intensity = Math.max(7, Math.min(100, (max === min ? .5 : (v - min) / (max - min)) * 100));
      const fill = `color-mix(in srgb, ${color(s, 0)} ${intensity}%, ${s.surface})`;
      mark(s, node(s.svg, 'rect', { x: left + cw * col, y: ch * row + 2, width: Math.max(.5, cw - 2), height: Math.max(.5, ch - 2), rx: 2, fill }), `${ds.label} · ${s.data.labels[col]}`, [{ label: ds.label, value: v, color: color(s, 0) }]);
    });
  });
  label(s, s.svg, left, s.height - 3, s.format(min), 'start');
  for (let i = 0; i < 8; i++) node(s.svg, 'rect', { x: left + 40 + i * 12, y: s.height - 14, width: 10, height: 10, rx: 2, fill: `color-mix(in srgb, ${color(s, 0)} ${8 + i * 92 / 7}%, ${s.surface})` });
  label(s, s.svg, left + 144, s.height - 3, s.format(max), 'start');
}

function radar(s: ChartScene) {
  const n = s.data.labels.length, max = Math.max(1, ...s.data.datasets.flatMap((ds) => ds.data));
  const radius = Math.max(20, Math.min(s.width / 2 - 70, s.height / 2 - 30));
  const g = node(s.svg, 'g', { transform: `translate(${s.width / 2},${s.height / 2})` });
  const point = (i: number, r: number): [number, number] => [Math.sin(i / n * Math.PI * 2) * r, -Math.cos(i / n * Math.PI * 2) * r];
  const path = line<[number, number]>().curve(curveLinearClosed);
  for (const fraction of [.25, .5, .75, 1]) node(g, 'path', { d: path(s.data.labels.map((_, i) => point(i, radius * fraction))) ?? '', fill: 'none', stroke: s.grid });
  s.data.labels.forEach((name, i) => {
    const [x, y] = point(i, radius), [lx, ly] = point(i, radius + 18);
    node(g, 'line', { x1: 0, x2: x, y1: 0, y2: y, stroke: s.grid });
    label(s, g, lx, ly + 4, short(name, 12), lx < -5 ? 'end' : lx > 5 ? 'start' : 'middle');
  });
  s.data.datasets.forEach((ds, si) => {
    const points = ds.data.map((v, i) => point(i, v / max * radius));
    node(g, 'path', { d: path(points) ?? '', fill: color(s, si), 'fill-opacity': .1, stroke: color(s, si), 'stroke-width': 2 });
    points.forEach(([cx, cy], i) => mark(s, node(g, 'circle', { cx, cy, r: 4, fill: color(s, si) }), s.data.labels[i], [{ label: ds.label, value: ds.data[i], color: color(s, si) }]));
  });
}

function funnel(s: ChartScene) {
  const values = s.data.datasets[0].data, max = Math.max(...values), h = (s.height - 12) / values.length;
  const usable = Math.max(50, s.width - 180), cx = usable / 2;
  values.forEach((v, i) => {
    const top = usable * v / max / 2, bottom = usable * (values[i + 1] ?? v * .75) / max / 2;
    const y = i * h + 2;
    const el = node(s.svg, 'path', { d: `M${cx - top},${y}H${cx + top}L${cx + bottom},${y + h - 3}H${cx - bottom}Z`, fill: color(s, i) });
    label(s, s.svg, usable + 12, y + h / 2 - 2, short(s.data.labels[i], 18), 'start');
    label(s, s.svg, usable + 12, y + h / 2 + 15, s.format(v), 'start');
    mark(s, el, s.data.labels[i], [{ label: s.data.datasets[0].label, value: v, color: color(s, i) }]);
  });
}

function treemap(s: ChartScene) {
  const entries = s.data.datasets[0].data.map((value, i) => ({ value, i })).filter((e) => e.value > 0);
  const draw = (items: typeof entries, x: number, y: number, w: number, h: number) => {
    if (items.length === 1) {
      const { i, value } = items[0];
      const el = node(s.svg, 'rect', { x: x + 1, y: y + 1, width: Math.max(0, w - 2), height: Math.max(0, h - 2), rx: 3, fill: color(s, i), 'fill-opacity': .18, stroke: color(s, i), 'stroke-opacity': .4 });
      if (w > 70 && h > 40) {
        label(s, s.svg, x + 10, y + 22, short(s.data.labels[i], Math.floor(w / 7) - 2), 'start').setAttribute('fill', s.foreground);
        label(s, s.svg, x + 10, y + 42, s.format(value), 'start');
      }
      mark(s, el, s.data.labels[i], [{ label: s.data.datasets[0].label, value, color: color(s, i) }]);
      return;
    }
    const total = items.reduce((sum, e) => sum + e.value, 0);
    let split = 1, first = items[0].value;
    while (split < items.length - 1 && first < total / 2) first += items[split++].value;
    const fraction = first / total;
    if (w >= h) {
      draw(items.slice(0, split), x, y, w * fraction, h);
      draw(items.slice(split), x + w * fraction, y, w * (1 - fraction), h);
    } else {
      draw(items.slice(0, split), x, y, w, h * fraction);
      draw(items.slice(split), x, y + h * fraction, w, h * (1 - fraction));
    }
  };
  draw(entries, 0, 0, s.width, s.height);
}

function gauge(s: ChartScene) {
  const value = s.data.datasets[0].data[0], max = s.data.max ?? 100;
  const radius = Math.min(s.width / 2 - 20, s.height - 75);
  const g = node(s.svg, 'g', { transform: `translate(${s.width / 2},${s.height - 50})` });
  const a = arc().innerRadius(radius * .82).outerRadius(radius).cornerRadius(3);
  node(g, 'path', { d: a({ innerRadius: 0, outerRadius: 0, startAngle: -Math.PI / 2, endAngle: Math.PI / 2 }) ?? '', fill: s.grid });
  mark(s, node(g, 'path', { d: a({ innerRadius: 0, outerRadius: 0, startAngle: -Math.PI / 2, endAngle: -Math.PI / 2 + Math.PI * value / max }) ?? '', fill: color(s, 0) }), s.data.labels[0], [{ label: s.data.datasets[0].label, value, color: color(s, 0) }]);
  node(g, 'text', { x: 0, y: -12, 'text-anchor': 'middle', fill: s.foreground, 'font-family': s.font, 'font-size': 32, 'font-weight': 600 }, s.format(value));
  label(s, g, -radius, 22, '0'); label(s, g, radius, 22, s.format(max));
}
