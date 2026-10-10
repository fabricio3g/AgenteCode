import type { ChartType } from './chart-types';
export type { ChartType } from './chart-types';

export interface Dataset {
  label: string;
  data: number[];
  sizes?: number[];
}

export interface ChartData {
  labels: string[];
  datasets: Dataset[];
  subtitle?: string;
  valueFormat?: 'number' | 'percent' | 'currency';
  currency?: string;
  max?: number;
  annotations?: Array<{ label: string; index: number }>;
}

function normalizeDataset(entry: unknown, fallbackLabel: string): Dataset | null {
  if (Array.isArray(entry)) {
    const data = entry.map((value) => Number(value));
    if (data.some((value) => !Number.isFinite(value))) return null;
    return data.length ? { label: fallbackLabel, data } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const rawData = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.values)
      ? record.values
      : null;
  if (!rawData) return null;
  const data = rawData.map((value) => Number(value));
  if (data.some((value) => !Number.isFinite(value))) return null;
  if (!data.length) return null;
  return {
    label: String(record.label || record.name || fallbackLabel),
    data,
    ...(Array.isArray(record.sizes) ? { sizes: record.sizes.map(Number) } : {})
  };
}

function normalizeChartData(value: unknown): ChartData | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    const nested = normalizeChartData(record.data);
    if (nested) return nested;
  }
  if (record.chartData && typeof record.chartData === 'object') {
    const nested = normalizeChartData(record.chartData);
    if (nested) return nested;
  }

  const labels = Array.isArray(record.labels)
    ? record.labels.map((label) => String(label))
    : Array.isArray(record.x)
      ? record.x.map((label) => String(label))
      : null;

  let datasets: Dataset[] = [];
  if (Array.isArray(record.datasets)) {
    datasets = record.datasets
      .map((entry, index) => normalizeDataset(entry, `Series ${index + 1}`))
      .filter((entry): entry is Dataset => !!entry);
  } else if (Array.isArray(record.series)) {
    datasets = record.series
      .map((entry, index) => normalizeDataset(entry, `Series ${index + 1}`))
      .filter((entry): entry is Dataset => !!entry);
  } else if (Array.isArray(record.values) || Array.isArray(record.data) || Array.isArray(record.y)) {
    const single = normalizeDataset({
      label: record.label || record.series || record.name || 'Series 1',
      data: record.values || record.data || record.y
    }, 'Series 1');
    if (single) datasets = [single];
  }

  if (!labels?.length || !datasets.length) return null;
  return {
    labels, datasets,
    ...(typeof record.subtitle === 'string' ? { subtitle: record.subtitle } : {}),
    ...(record.valueFormat === 'number' || record.valueFormat === 'percent' || record.valueFormat === 'currency' ? { valueFormat: record.valueFormat } : {}),
    ...(typeof record.currency === 'string' ? { currency: record.currency } : {}),
    ...(typeof record.max === 'number' ? { max: record.max } : {}),
    ...(Array.isArray(record.annotations) ? { annotations: record.annotations.filter((a): a is { label: string; index: number } => !!a && typeof a.label === 'string' && Number.isInteger(a.index)) } : {})
  };
}

function extractJsonObjects(input: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        out.push(input.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return out;
}

function mergeChartFragments(fragments: unknown[]): ChartData | null {
  const merged: ChartData = { labels: [], datasets: [] };

  for (const fragment of fragments) {
    const normalized = normalizeChartData(fragment);
    if (normalized) return normalized;
    if (!fragment || typeof fragment !== 'object') continue;
    const record = fragment as Record<string, unknown>;

    if (!merged.labels.length) {
      const labels = Array.isArray(record.labels)
        ? record.labels.map((label) => String(label))
        : Array.isArray(record.x)
          ? record.x.map((label) => String(label))
          : null;
      if (labels?.length) merged.labels = labels;
    }

    if (!merged.datasets.length) {
      if (Array.isArray(record.datasets)) {
        merged.datasets = record.datasets
          .map((entry, index) => normalizeDataset(entry, `Series ${index + 1}`))
          .filter((entry): entry is Dataset => !!entry);
      } else if (Array.isArray(record.series)) {
        merged.datasets = record.series
          .map((entry, index) => normalizeDataset(entry, `Series ${index + 1}`))
          .filter((entry): entry is Dataset => !!entry);
      } else if (Array.isArray(record.values) || Array.isArray(record.data) || Array.isArray(record.y)) {
        const single = normalizeDataset({
          label: record.label || record.series || record.name || 'Series 1',
          data: record.values || record.data || record.y
        }, 'Series 1');
        if (single) merged.datasets = [single];
      }
    }
  }

  return merged.labels.length && merged.datasets.length ? merged : null;
}

function candidateJsonStrings(input: string): string[] {
  const trimmed = input.trim();
  const candidates = new Set<string>();
  if (!trimmed) return [];
  candidates.add(trimmed);

  const fenced = trimmed.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.add(fenced[1].trim());

  const assigned = trimmed.match(/[A-Za-z_$][\w$]*\s*=\s*([\s\S]+)/);
  if (assigned?.[1]) candidates.add(assigned[1].trim().replace(/;$/, ''));

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.add(trimmed.slice(firstBrace, lastBrace + 1));
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.add(trimmed.slice(firstBracket, lastBracket + 1));
  }

  return [...candidates];
}

export function parseChartData(input: string): ChartData | null {
  for (const candidate of candidateJsonStrings(input)) {
    try {
      const parsedValue = JSON.parse(candidate);
      const normalized = normalizeChartData(parsedValue);
      if (normalized) return normalized;
    } catch {
    }
  }

  const jsonFragments = extractJsonObjects(input);
  if (jsonFragments.length > 1) {
    const parsedFragments: unknown[] = [];
    for (const fragment of jsonFragments) {
      try {
        parsedFragments.push(JSON.parse(fragment));
      } catch {
      }
    }
    const merged = mergeChartFragments(parsedFragments);
    if (merged) return merged;
  }

  const stitched = input
    .replace(/}\s*{/g, '},{')
    .replace(/}\s*$/g, '}')
    .trim();
  if (stitched !== input.trim()) {
    for (const candidate of candidateJsonStrings(stitched)) {
      try {
        const parsedValue = JSON.parse(candidate);
        const normalized = normalizeChartData(parsedValue);
        if (normalized) return normalized;
      } catch {
      }
    }
  }

  return null;
}

export function looksLikeChartData(input: string): boolean {
  return !!parseChartData(input);
}

export function inferChartType(context: string, data?: ChartData | null): ChartType {
  const lower = context.toLowerCase();
  if (/\bheat\s?map\b/.test(lower)) return 'heatmap';
  if (/\b100%.*area\b/.test(lower)) return 'percent_area';
  if (/\bstacked.area\b/.test(lower)) return 'stacked_area';
  if (/\bstacked.bar\b/.test(lower)) return 'stacked_bar';
  if (/\bhistogram\b/.test(lower)) return 'histogram';
  if (/\bscatter\b/.test(lower)) return 'scatter';
  if (/\bwaterfall\b/.test(lower)) return 'waterfall';
  if (/\bbox.plot\b/.test(lower)) return 'boxplot';
  if (/\barea\b/.test(lower)) return 'area';
  if (/\bdonut\b/.test(lower)) return 'donut';
  if (/\bpie\b/.test(lower)) return 'pie';
  if (/\bline\b|\btrend\b|\bhistory\b|\bhistorical\b|\bover time\b|\btimeline\b/.test(lower)) return 'line';
  if (/\bbar\b|\bcolumn\b|\bcompare\b|\bcomparison\b/.test(lower)) return 'bar';

  const labels = data?.labels || [];
  const temporalish = labels.filter((label) => {
    const trimmed = label.trim();
    return /^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(trimmed)
      || /^\d+(?:\.\d+)?$/.test(trimmed)
      || (!Number.isNaN(Date.parse(trimmed)) && /[A-Za-z]/.test(trimmed));
  }).length;
  if (labels.length > 1 && temporalish >= Math.ceil(labels.length * 0.6)) return 'line';
  return 'bar';
}

export function inferChartTitle(contextBefore: string): string | undefined {
  const lines = contextBefore.split('\n').map((line) => line.trim()).filter(Boolean);
  const candidate = lines.at(-1)?.replace(/^#{1,6}\s*/, '').replace(/^[-*]\s*/, '').replace(/:$/, '').trim();
  if (!candidate) return undefined;
  if (candidate.length > 80) return undefined;
  if (candidate.includes('{') || candidate.includes('```')) return undefined;
  return candidate;
}
