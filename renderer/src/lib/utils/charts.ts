import { inferChartTitle, inferChartType, looksLikeChartData, parseChartData, type ChartType } from './chart-data';

/** Parsed segment from LLM output — either plain markdown text or a chart block */
export type ContentSegment =
  | { kind: 'text'; content: string }
  | {
      kind: 'chart';
      type: ChartType;
      title?: string;
      xlabel?: string;
      ylabel?: string;
      raw: string;
    };

const CHART_TAG = /<chart([^>]*)>([\s\S]*?)<\/chart>/gi;
const CODE_FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const SYSTEM_REMINDER_TAG = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m?.[1];
}

export function sanitizeAssistantArtifacts(content: string): string {
  return String(content || '')
    .replace(SYSTEM_REMINDER_TAG, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split content into interleaved text/chart segments.
 * `<chart type="bar" title="Revenue" xlabel="Month" ylabel="$">{ JSON }</chart>`
 */
export function parseContentSegments(content: string): ContentSegment[] {
  const sanitized = sanitizeAssistantArtifacts(content);
  const markers: Array<{ start: number; end: number; segment: ContentSegment }> = [];

  for (const match of sanitized.matchAll(CHART_TAG)) {
    const start = match.index!;
    const end = start + match[0].length;
    const attrsStr = match[1] ?? '';
    const raw = (match[2] ?? '').trim();
    const parsed = parseChartData(raw);
    const typeRaw = attr(attrsStr, 'type') ?? 'bar';
    const chartType = ['bar', 'line', 'pie', 'donut'].includes(typeRaw)
      ? (typeRaw as ChartType)
      : 'bar';

    if (!parsed) {
      const fallbackTitle = attr(attrsStr, 'title');
      markers.push({
        start,
        end,
        segment: {
          kind: 'text',
          content: fallbackTitle ? `**${fallbackTitle}**` : ''
        }
      });
      continue;
    }

    markers.push({
      start,
      end,
      segment: {
        kind: 'chart',
        type: chartType,
        title: attr(attrsStr, 'title'),
        xlabel: attr(attrsStr, 'xlabel'),
        ylabel: attr(attrsStr, 'ylabel'),
        raw
      }
    });
  }

  for (const match of sanitized.matchAll(CODE_FENCE)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (markers.some((marker) => start < marker.end && end > marker.start)) continue;

    const info = (match[1] ?? '').trim();
    const raw = (match[2] ?? '').trim();
    if (!looksLikeChartData(raw)) continue;

    const data = parseChartData(raw);
    const surroundingContext = `${info}\n${sanitized.slice(Math.max(0, start - 160), start)}\n${sanitized.slice(end, Math.min(sanitized.length, end + 120))}`;
    markers.push({
      start,
      end,
      segment: {
        kind: 'chart',
        type: inferChartType(surroundingContext, data),
        title: inferChartTitle(sanitized.slice(Math.max(0, start - 160), start)),
        raw
      }
    });
  }

  markers.sort((a, b) => a.start - b.start);

  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  for (const marker of markers) {
    if (marker.start > lastIndex) {
      segments.push({ kind: 'text', content: sanitized.slice(lastIndex, marker.start) });
    }
    segments.push(marker.segment);
    lastIndex = marker.end;
  }

  if (lastIndex < sanitized.length) {
    segments.push({ kind: 'text', content: sanitized.slice(lastIndex) });
  }

  return segments.length ? segments.filter((segment) => segment.kind !== 'text' || segment.content.trim()) : [{ kind: 'text', content: sanitized }];
}

/** Strip chart tags from content so TTS / copy doesn't include JSON blobs */
export function stripChartBlocks(content: string): string {
  let output = sanitizeAssistantArtifacts(content).replace(CHART_TAG, '[chart]');
  output = output.replace(CODE_FENCE, (full, _info, body) => (looksLikeChartData(String(body || '')) ? '[chart]' : full));
  return output;
}
