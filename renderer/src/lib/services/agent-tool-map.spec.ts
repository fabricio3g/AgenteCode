import { describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolResult } from '$lib/services/agent-types';
import { handleCreateMap } from '$lib/services/agent-tool-artifacts';

function makeCtx(): ToolContext {
  return { chatId: 'c1', files: {}, executionMode: 'sandbox' } as ToolContext;
}

const ok = (output: unknown, extra?: Record<string, unknown>): ToolResult =>
  ({ success: true, output, ...extra }) as ToolResult;
const fail = (error: string, note?: string): ToolResult => ({ success: false, error, note });

function run(args: Record<string, unknown>, geocode = vi.fn()) {
  const ctx = makeCtx();
  return handleCreateMap({
    args,
    ctx,
    normPath: (v) => String(v || ''),
    geocodePlace: geocode,
    ok,
    fail
  }).then((result) => ({ result, ctx, geocode }));
}

function payloadOf(ctx: ToolContext) {
  return JSON.parse(ctx.files['map.json']);
}

describe('handleCreateMap', () => {
  it('resolves a place name into coordinates', async () => {
    const geocode = vi.fn().mockResolvedValue({
      latitude: -32.6167,
      longitude: -60.15,
      label: 'Victoria, Entre Ríos, Argentina'
    });
    const { result, ctx } = await run({ place: 'Victoria, Entre Rios' }, geocode);

    expect(result.success).toBe(true);
    expect(geocode).toHaveBeenCalledWith('Victoria, Entre Rios');
    const payload = payloadOf(ctx);
    expect(payload.latitude).toBeCloseTo(-32.6167, 4);
    expect(payload.longitude).toBeCloseTo(-60.15, 4);
    // The resolved name becomes the title when none was given.
    expect(payload.title).toBe('Victoria, Entre Ríos, Argentina');
  });

  it('drops a marker on the resolved point so it is actually visible', async () => {
    const geocode = vi.fn().mockResolvedValue({ latitude: 40.4, longitude: -3.7, label: 'Madrid, Spain' });
    const { ctx } = await run({ place: 'Madrid' }, geocode);
    const payload = payloadOf(ctx);
    expect(payload.markers).toEqual([{ lat: 40.4, lng: -3.7, label: 'Madrid, Spain' }]);
  });

  it('does not add a marker when the model supplied its own', async () => {
    const geocode = vi.fn().mockResolvedValue({ latitude: 40.4, longitude: -3.7, label: 'Madrid, Spain' });
    const { ctx } = await run(
      { place: 'Madrid', markers: [{ lat: 41.9, lng: 12.5, label: 'Rome' }] },
      geocode
    );
    expect(payloadOf(ctx).markers).toHaveLength(1);
    expect(payloadOf(ctx).markers[0].label).toBe('Rome');
  });

  it('prefers explicit coordinates and skips the network entirely', async () => {
    const geocode = vi.fn();
    const { result, ctx } = await run({ place: 'Madrid', latitude: 10, longitude: 20 }, geocode);

    expect(result.success).toBe(true);
    expect(geocode).not.toHaveBeenCalled();
    expect(payloadOf(ctx).latitude).toBe(10);
    expect(payloadOf(ctx).longitude).toBe(20);
  });

  it('accepts the equator and the prime meridian', async () => {
    // `!latitude || !longitude` would reject 0,0 — the bug the shared geocoder fixed.
    const { result, ctx } = await run({ latitude: 0, longitude: 0, title: 'Null Island' });
    expect(result.success).toBe(true);
    expect(payloadOf(ctx).latitude).toBe(0);
    expect(payloadOf(ctx).longitude).toBe(0);
  });

  it('fails clearly when neither a place nor coordinates are given', async () => {
    /*
     * The old handler defaulted to London. An under-specified map silently answered a
     * completely different question, which reads as success to both model and user.
     */
    const { result, ctx } = await run({ title: 'Nowhere' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/place name or latitude and longitude/i);
    expect(ctx.files['map.json']).toBeUndefined();
  });

  it('reports a geocoding failure instead of inventing a location', async () => {
    const geocode = vi.fn().mockRejectedValue(new Error('Location not found: Atlantis'));
    const { result, ctx } = await run({ place: 'Atlantis' }, geocode);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Atlantis');
    expect(result.note).toMatch(/explicit latitude and longitude/i);
    expect(ctx.files['map.json']).toBeUndefined();
  });

  it('passes polylines through untouched for the renderer to harden', async () => {
    const { ctx } = await run({
      latitude: 1,
      longitude: 2,
      polylines: [null, { coords: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }] }]
    });
    // The handler must not throw on a null entry; ArtifactMap's normalizeLine drops it.
    expect(payloadOf(ctx).polylines).toHaveLength(2);
  });
});
