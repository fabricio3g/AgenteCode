/** One chart vocabulary for tools, persisted artifacts, markdown and the viewer. */
export const CHART_TYPES = [
  'bar', 'horizontal_bar', 'stacked_bar', 'percent_bar',
  'line', 'step', 'area', 'stacked_area', 'percent_area',
  'pie', 'donut', 'scatter', 'bubble', 'heatmap', 'histogram',
  'waterfall', 'radar', 'lollipop', 'dot', 'boxplot', 'funnel', 'treemap', 'gauge'
] as const;

export type ChartType = typeof CHART_TYPES[number];

export const CHART_NAMES: Record<ChartType, string> = {
  bar: 'Grouped bars', horizontal_bar: 'Horizontal bars', stacked_bar: 'Stacked bars', percent_bar: '100% stacked bars',
  line: 'Line', step: 'Step line', area: 'Area', stacked_area: 'Stacked area', percent_area: '100% stacked area',
  pie: 'Pie', donut: 'Donut', scatter: 'Scatter', bubble: 'Bubble', heatmap: 'Heatmap', histogram: 'Histogram',
  waterfall: 'Waterfall', radar: 'Radar', lollipop: 'Lollipop', dot: 'Dot plot', boxplot: 'Box plot',
  funnel: 'Funnel', treemap: 'Treemap', gauge: 'Gauge'
};

const ALIASES: Record<string, ChartType> = {
  column: 'bar', columns: 'bar', horizontal: 'horizontal_bar', stacked: 'stacked_bar',
  '100%_stacked_bar': 'percent_bar', normalized_bar: 'percent_bar',
  '100%_stacked_area': 'percent_area', normalized_area: 'percent_area',
  spline: 'line', line_chart: 'line', trend: 'line', step_line: 'step',
  doughnut: 'donut', ring: 'donut', pie_chart: 'pie', box: 'boxplot', box_plot: 'boxplot',
  heat_map: 'heatmap', scatterplot: 'scatter', scatter_plot: 'scatter'
};

export function resolveChartType(value: unknown): ChartType | null {
  const name = String(value ?? '').trim().toLowerCase().replace(/[ -]+/g, '_');
  return CHART_TYPES.includes(name as ChartType) ? name as ChartType : ALIASES[name] ?? null;
}
