import { scaleBand, scaleLinear, scaleSqrt } from 'd3-scale';
import { area, line, curveMonotoneX, curveStepAfter } from 'd3-shape';
import { stackValues, waterfallValues, histogramBins, fiveNumbers } from '$lib/utils/chart-math';
import { node, label, mark, short, color, type ChartScene } from './chart-scene';

export function drawCartesian(s: ChartScene) {
  let data = s.data;
  if (s.type === 'histogram') {
    const bins = histogramBins(data.datasets[0].data);
    data = { labels: bins.map((b) => `${s.format(b.start)}–${s.format(b.end)}`), datasets: [{ label: 'Frequency', data: bins.map((b) => b.count) }] };
  }
  const horizontal = s.type === 'horizontal_bar';
  const stacked = ['stacked_bar', 'percent_bar', 'stacked_area', 'percent_area'].includes(s.type);
  const percent = ['percent_bar', 'percent_area'].includes(s.type);
  const scatter = ['scatter', 'bubble'].includes(s.type);
  const connected = ['line', 'step', 'area', 'stacked_area', 'percent_area'].includes(s.type);
  const box = s.type === 'boxplot';
  const indices = data.labels.map((_, i) => String(i));
  const margin = { left: horizontal ? Math.min(110, s.width * .28) : 52, right: 12, top: 12, bottom: 36 };
  const w = s.width - margin.left - margin.right, h = s.height - margin.top - margin.bottom;
  const g = node(s.svg, 'g', { transform: `translate(${margin.left},${margin.top})` });
  const stacks = stacked ? stackValues(data, percent) : [];
  const falls = s.type === 'waterfall' ? waterfallValues(data.datasets[0].data) : [];
  const values = stacks.length ? stacks.flat(2) : falls.length ? falls.flat() : data.datasets.flatMap((ds) => ds.data);
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const scale = scaleLinear().domain(percent ? [0, 100] : [low, high === low ? high + 1 : high]).nice().range(horizontal ? [0, w] : [h, 0]);
  const categories = box ? data.datasets.map((_, i) => String(i)) : indices;
  const band = scaleBand().domain(categories).range(horizontal ? [0, h] : [0, w]).padding(.22);
  const numericX = scaleLinear().domain(scatter ? [Math.min(...data.labels.map(Number)), Math.max(...data.labels.map(Number))] : [0, 1]).nice().range([0, w]);
  const timeX = scaleLinear().domain([0, Math.max(1, data.labels.length - 1)]).range([0, w]);
  const x = (i: number) => scatter ? numericX(Number(data.labels[i])) : connected ? data.labels.length === 1 ? w / 2 : timeX(i) : (band(String(i)) ?? 0) + band.bandwidth() / 2;
  const tickFormat = (v: number) => percent ? `${v}%` : s.format(v);
  for (const tick of scale.ticks(4)) {
    const pos = scale(tick);
    node(g, 'line', horizontal ? { x1: pos, x2: pos, y1: 0, y2: h, stroke: s.grid } : { x1: 0, x2: w, y1: pos, y2: pos, stroke: s.grid });
    label(s, g, horizontal ? pos : -8, horizontal ? h + 22 : pos + 4, tickFormat(tick), horizontal ? 'middle' : 'end');
  }
  const categoryLabels = box ? data.datasets.map((ds) => ds.label) : data.labels;
  if (scatter) {
    for (const tick of numericX.ticks(Math.max(2, Math.floor(w / 85)))) label(s, g, numericX(tick), h + 22, s.format(tick));
  } else {
    const every = Math.max(1, Math.ceil(categories.length / (horizontal ? Math.floor(h / 24) : Math.max(2, Math.floor(w / 80)))));
    categories.forEach((key, i) => {
      if (i % every) return;
      const pos = connected ? x(i) : (band(key) ?? 0) + band.bandwidth() / 2;
      label(s, g, horizontal ? -8 : pos, horizontal ? pos + 4 : h + 22, short(categoryLabels[i], horizontal ? 15 : 12), horizontal ? 'end' : 'middle');
    });
  }
  node(g, 'line', horizontal ? { x1: scale(0), x2: scale(0), y1: 0, y2: h, stroke: s.grid } : { x1: 0, x2: w, y1: scale(0), y2: scale(0), stroke: s.grid });
  const allRows = (i: number) => data.datasets.map((ds, si) => ({ label: ds.label, value: ds.data[i], color: color(s, si) }));
  if (box) {
    data.datasets.forEach((ds, si) => {
      const [min, q1, median, q3, max] = fiveNumbers(ds.data), cx = x(si), bw = band.bandwidth() * .6;
      node(g, 'line', { x1: cx, x2: cx, y1: scale(max), y2: scale(min), stroke: color(s, si) });
      for (const v of [min, max]) node(g, 'line', { x1: cx - bw / 3, x2: cx + bw / 3, y1: scale(v), y2: scale(v), stroke: color(s, si) });
      const el = node(g, 'rect', { x: cx - bw / 2, y: scale(q3), width: bw, height: Math.max(1, scale(q1) - scale(q3)), fill: color(s, si), 'fill-opacity': .18, stroke: color(s, si), rx: 2 });
      node(g, 'line', { x1: cx - bw / 2, x2: cx + bw / 2, y1: scale(median), y2: scale(median), stroke: color(s, si), 'stroke-width': 2 });
      mark(s, el, ds.label, ['Minimum', 'Q1', 'Median', 'Q3', 'Maximum'].map((label, i) => ({ label, value: [min, q1, median, q3, max][i], color: color(s, si) })));
    });
    return;
  }
  if (falls.length) {
    falls.forEach(([start, end], i) => {
      const bx = band(String(i)) ?? 0;
      const el = node(g, 'rect', { x: bx, y: scale(Math.max(start, end)), width: band.bandwidth(), height: Math.max(1, Math.abs(scale(end) - scale(start))), rx: 2, fill: end >= start ? color(s, 1) : color(s, 3) });
      mark(s, el, data.labels[i], [{ label: 'Change', value: data.datasets[0].data[i], color: color(s, end >= start ? 1 : 3) }, { label: 'Running total', value: end, color: color(s, 0) }]);
      if (i < falls.length - 1) node(g, 'line', { x1: bx + band.bandwidth(), x2: band(String(i + 1)) ?? 0, y1: scale(end), y2: scale(end), stroke: s.muted, 'stroke-dasharray': '3 3' });
    });
  } else {
    data.datasets.forEach((ds, si) => {
      const ink = color(s, si);
      if (['bar', 'horizontal_bar', 'stacked_bar', 'percent_bar', 'histogram'].includes(s.type)) {
        ds.data.forEach((v, i) => {
          const pair = stacked ? stacks[si][i] : [0, v];
          const thickness = band.bandwidth() / (stacked ? 1 : data.datasets.length);
          const pos = (band(String(i)) ?? 0) + (stacked ? 0 : si * thickness);
          const attrs = horizontal
            ? { x: scale(Math.min(...pair)), y: pos, width: Math.max(1, Math.abs(scale(pair[1]) - scale(pair[0]))), height: Math.max(1, thickness - 1) }
            : { x: pos, y: scale(Math.max(...pair)), width: Math.max(1, thickness - 1), height: Math.max(1, Math.abs(scale(pair[1]) - scale(pair[0]))) };
          mark(s, node(g, 'rect', { ...attrs, fill: ink, rx: stacked ? 0 : 2 }), data.labels[i], allRows(i));
        });
      } else if (scatter) {
        const radius = scaleSqrt().domain([0, Math.max(1, ...(ds.sizes ?? []))]).range([0, 20]);
        ds.data.forEach((v, i) => {
          const rows = [{ label: 'x', value: Number(data.labels[i]), color: ink }, { label: ds.label, value: v, color: ink }];
          if (s.type === 'bubble' && ds.sizes) rows.push({ label: 'Size', value: ds.sizes[i], color: ink });
          mark(s, node(g, 'circle', { cx: x(i), cy: scale(v), r: s.type === 'bubble' ? ds.sizes ? Math.max(3, radius(ds.sizes[i])) : 10 : 4, fill: ink, 'fill-opacity': .65, stroke: ink, 'stroke-width': 1 }), ds.label, rows);
        });
      } else if (['dot', 'lollipop'].includes(s.type)) {
        ds.data.forEach((v, i) => {
          const cx = x(i) + (si - (data.datasets.length - 1) / 2) * 8;
          if (s.type === 'lollipop') node(g, 'line', { x1: cx, x2: cx, y1: scale(0), y2: scale(v), stroke: ink, 'stroke-width': 2 });
          mark(s, node(g, 'circle', { cx, cy: scale(v), r: 4, fill: ink }), data.labels[i], allRows(i));
        });
      } else {
        const curved = s.type === 'step' ? curveStepAfter : curveMonotoneX;
        if (s.type.includes('area')) {
          const pairs = stacked ? stacks[si] : ds.data.map((v): [number, number] => [0, v]);
          const path = area<[number, number]>().x((_, i) => x(i)).y0((v) => scale(v[0])).y1((v) => scale(v[1])).curve(curved)(pairs);
          node(g, 'path', { d: path ?? '', fill: ink, 'fill-opacity': stacked ? .88 : .16 });
        }
        const points = stacked ? stacks[si].map((v) => v[1]) : ds.data;
        node(g, 'path', { d: line<number>().x((_, i) => x(i)).y((v) => scale(v)).curve(curved)(points) ?? '', fill: 'none', stroke: ink, 'stroke-width': stacked ? .75 : 2, 'stroke-linejoin': 'round' });
        if (data.labels.length === 1) node(g, 'circle', { cx: x(0), cy: scale(points[0]), r: 4, fill: ink });
      }
    });
  }
  // One band per x value makes dense lines easy to inspect, including repeated values.
  if (connected) {
    data.labels.forEach((name, i) => {
      const left = i === 0 ? 0 : (x(i - 1) + x(i)) / 2;
      const right = i === data.labels.length - 1 ? w : (x(i) + x(i + 1)) / 2;
      mark(s, node(g, 'rect', { x: left, y: 0, width: Math.max(1, right - left), height: h, fill: 'transparent' }), name, allRows(i));
    });
  }
  for (const annotation of data.annotations ?? []) {
    if (annotation.index < 0 || annotation.index >= data.labels.length) continue;
    const ax = x(annotation.index);
    node(g, 'line', { x1: ax, x2: ax, y1: 0, y2: h, stroke: s.muted, 'stroke-dasharray': '4 3' });
    const text = label(s, g, Math.min(w, Math.max(4, ax + 5)), s.fontSize, short(annotation.label, 26), ax > w * .6 ? 'end' : 'start');
    text.setAttribute('fill', s.foreground);
    text.setAttribute('paint-order', 'stroke');
    text.setAttribute('stroke', s.surface);
    text.setAttribute('stroke-width', '3');
    text.setAttribute('stroke-linejoin', 'round');
  }
}
