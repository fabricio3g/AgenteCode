import { describe, expect, it } from 'vitest';
import { QUASAR_ASSEMBLY, QUASAR_ORBIT_PERIOD, quasarOrbitalField, quasarTiles } from './quasar-field';

describe('quasar field', () => {
  it('leaves the event horizon empty', () => {
    expect(quasarOrbitalField(0, 0)).toBe(0);
  });

  it('draws the same 15×15 field as the brand generator', () => {
    const tiles = quasarTiles();

    // `assets/brand/agente-code-icon-small.svg` is this field: 88 tiles, the
    // brightest core at the 6.8-unit step's full shading.
    expect(tiles).toHaveLength(88);
    expect(tiles).toContainEqual(
      expect.objectContaining({ x: 43.34, y: 43.34, size: 6.12, rx: 1.35, opacity: 1 }),
    );
  });

  it('places every tile once around the orbit', () => {
    const delays = quasarTiles().map((tile) => tile.delay);

    expect(Math.min(...delays)).toBeGreaterThanOrEqual(-QUASAR_ORBIT_PERIOD);
    expect(Math.max(...delays)).toBeLessThanOrEqual(0);
    // Not one shared delay: the highlight has to travel.
    expect(new Set(delays).size).toBeGreaterThan(20);
  });

  it('lights the field from the horizon outward on launch', () => {
    const tiles = quasarTiles();
    const distance = (tile: (typeof tiles)[number]) => Math.hypot(tile.x + tile.size / 2 - 60, tile.y + tile.size / 2 - 60);
    const nearest = tiles.reduce((a, b) => (distance(a) < distance(b) ? a : b));
    const farthest = tiles.reduce((a, b) => (distance(a) > distance(b) ? a : b));

    expect(nearest.enter).toBeLessThan(farthest.enter);
    expect(Math.min(...tiles.map((tile) => tile.enter))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...tiles.map((tile) => tile.enter))).toBeLessThanOrEqual(QUASAR_ASSEMBLY);
  });
});
