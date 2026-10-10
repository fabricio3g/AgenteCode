import { CHART_TYPES } from '$lib/utils/chart-types';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '$lib/services/agent-types';
import { handleCreateChart, handleCreateDashboard, handleCreateMap, handleCreateReport } from '$lib/services/agent-tool-artifacts';
import { validateGeneratedDocumentArgs } from '$lib/services/generated-documents';

function makeCtx(): ToolContext {
  return { chatId: 'c1', files: {}, executionMode: 'sandbox' };
}
const ok = (output: unknown, extra?: Record<string, unknown>) => ({ success: true as const, output, ...extra });
const fail = (error: string) => ({ success: false as const, error });

const BODY =
  'Nimbus 3 ships on October 14. The goal is twenty thousand sign-ups in the first two weeks, led by a waitlist campaign and a partner webinar with three launch partners.';

function report(args: Record<string, unknown>, ctx = makeCtx()) {
  return handleCreateReport({
    args,
    ctx,
    normPath: (value) => String(value || ''),
    isWorkspace: () => false,
    writeWorkspaceFile: async () => '',
    validateGeneratedDocumentArgs,
    ok,
    fail
  });
}

describe('create_report', () => {
  it('accepts a report written as one content body', async () => {
    const ctx = makeCtx();
    const result = await report({ title: 'Launch brief', content: BODY }, ctx);
    expect(result.success).toBe(true);
    expect(ctx.files['report.md']).toContain('Nimbus 3 ships on October 14');
  });

  it('renders markdown, bullets and citations in HTML, and escapes the title', async () => {
    const ctx = makeCtx();
    const result = await report({
      title: 'Plan <b>Q3</b>',
      format: 'html',
      sections: [{ title: 'Goals', content: `**Bold claim.** ${BODY}`, bullets: ['Grow the waitlist past ten thousand people'], citations: ['Survey 2026'] }]
    }, ctx);
    expect(result.success).toBe(true);
    const html = ctx.files['report.html'];
    expect(html).toContain('<strong>Bold claim.</strong>');
    expect(html).toContain('<li>Grow the waitlist past ten thousand people</li>');
    expect(html).toContain('Survey 2026');
    expect(html).toContain('Plan &lt;b&gt;Q3&lt;/b&gt;');
    expect(html).not.toContain('&lt;br/&gt;');
  });
});

describe('create_map', () => {
  it('centers on markers when no place or coordinates are given', async () => {
    const ctx = makeCtx();
    const result = await handleCreateMap({
      args: { title: 'Offices', markers: [{ lat: 40, lng: -3, label: 'Madrid' }, { lat: 48, lng: 2, label: 'Paris' }] },
      ctx,
      normPath: (value) => String(value || ''),
      geocodePlace: async () => { throw new Error('should not geocode'); },
      ok,
      fail
    });
    expect(result.success).toBe(true);
    const payload = JSON.parse(ctx.files['map.json']);
    expect(payload.latitude).toBe(44);
    expect(payload.longitude).toBe(-0.5);
    expect(payload.zoom).toBeGreaterThanOrEqual(2);
  });
});


describe('chart and dashboard deliverables', () => {
  const chart = { title: 'Trend', labels: ['1', '2', '3', '4'], datasets: [{ label: 'Series', data: [10, 20, 30, 40], sizes: [1, 2, 3, 4] }] };
  it.each(CHART_TYPES)('persists %s through the creation tool', async (chart_type) => {
    const ctx = makeCtx();
    const result = await handleCreateChart({ args: { ...chart, chart_type, subtitle: 'Sample', annotations: [{ index: 2, label: 'Release' }] }, ctx, normPath: (v) => String(v || ''), ok, fail });
    expect(result.success).toBe(true);
    const payload = JSON.parse(ctx.files['chart.json']);
    expect(payload.chartType).toBe(chart_type);
    expect(payload.datasets[0].sizes).toEqual([1, 2, 3, 4]);
    expect(payload.annotations[0].label).toBe('Release');
  });
  it('keeps nested dashboard charts and rejects invalid charts before writing', async () => {
    const ctx = makeCtx();
    const params = { ctx, normPath: (v: unknown) => String(v || ''), ok, fail };
    const result = await handleCreateDashboard({ ...params, args: { title: 'Metrics', metrics: [{ label: 'Total', value: 10 }], charts: [{ ...chart, chart_type: 'stacked_area' }] } });
    expect(result.success).toBe(true);
    expect(JSON.parse(ctx.files['dashboard.json']).charts[0].chartType).toBe('stacked_area');
    const before = { ...ctx.files };
    const bad = await handleCreateDashboard({ ...params, args: { title: 'Bad', path: 'bad.json', metrics: [{ label: 'Total', value: 10 }], charts: [{ ...chart, labels: ['1'], chart_type: 'line' }] } });
    expect(bad.success).toBe(false);
    expect(ctx.files).toEqual(before);
  });
});
