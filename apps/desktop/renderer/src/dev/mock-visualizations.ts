import { CHART_TYPES, CHART_NAMES } from '$lib/utils/chart-types';
import type { AgentArtifact, ChartArtifactPayload } from '$lib/types/chat';
function inline(payload: NonNullable<AgentArtifact['inline']>, file: string): AgentArtifact {
  return { title: payload.title, inline: payload, files: { [file]: JSON.stringify(payload) }, manifest: { schemaVersion: 1, kind: payload.kind, presentation: 'inline', entryPath: file, status: 'ready' } };
}
const dates = Array.from({ length: 14 }, (_, i) => `Sep ${i + 1}`);
const next = [0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 48, 55, 57, 58];
const core = [55, 52, 54, 51, 50, 46, 47, 43, 40, 10, 5, 3, 2, 2];
const team = [20, 22, 21, 24, 23, 25, 24, 26, 28, 35, 30, 26, 25, 24];
export const VISUALIZATION_DEMO: AgentArtifact[] = [inline({ kind: 'dashboard', title: 'A closer look at how people work', subtitle: 'Illustrative sample data · September 1–14 · local time',
  metrics: [{ label: 'days observed', value: '14' }, { label: 'hours mapped', value: '168' }, { label: 'model families', value: '4' }, { label: 'Next model share', value: '58', unit: '%' }, { label: 'peak activity', value: '3 PM' }], sections: [], charts: [
    { kind: 'chart', chartType: 'percent_area', title: 'Next reaches 58% of turns after launch', subtitle: 'Daily share of turns by model family. Sample data, not production telemetry.', labels: dates, valueFormat: 'percent', datasets: [{ label: 'Core', data: core }, { label: 'Next', data: next }, { label: 'Team', data: team }, { label: 'Other', data: core.map((v, i) => 100 - v - next[i] - team[i]) }], annotations: [{ index: 9, label: 'Next launches · Sep 10' }] },
    { kind: 'chart', chartType: 'heatmap', title: 'Thursday at 3 PM is the busiest hour', subtitle: 'Activity by weekday and local hour · illustrative counts', labels: Array.from({ length: 24 }, (_, i) => `${i % 12 || 12}${i < 12 ? 'a' : 'p'}`), datasets: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, day) => ({ label, data: Array.from({ length: 24 }, (_, hour) => Math.round((day < 5 ? 85 : 38) * Math.exp(-((hour - 15) ** 2) / 28) + (day === 3 && hour === 15 ? 45 : 0) + 4)) })) }
  ] }, 'demo-insights.json')];

const common = { labels: ['1', '2', '3', '4', '5', '6'], datasets: [{ label: 'Product', data: [12, 28, 19, 34, 27, 42], sizes: [8, 18, 12, 24, 16, 30] }, { label: 'Services', data: [8, 14, 18, 21, 24, 28] }] };
for (const chartType of CHART_TYPES) {
  const payload: ChartArtifactPayload = { kind: 'chart', title: CHART_NAMES[chartType], subtitle: 'Chart catalog · illustrative sample data', chartType, ...common };
  if (chartType === 'heatmap') continue;
  if (chartType === 'waterfall') payload.datasets = [{ label: 'Change', data: [40, -8, 15, -4, 20, -6] }];
  if (chartType === 'funnel') { payload.labels = ['Visits', 'Sign-ups', 'Activated', 'Subscribed']; payload.datasets = [{ label: 'People', data: [4200, 2100, 1400, 620] }]; }
  if (chartType === 'gauge') { payload.labels = ['Completion']; payload.datasets = [{ label: 'Completion', data: [72] }]; payload.max = 100; }
  VISUALIZATION_DEMO.push(inline(payload, `demo-${chartType}.json`));
}
