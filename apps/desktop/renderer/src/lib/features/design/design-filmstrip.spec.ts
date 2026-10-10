import { describe, expect, it } from 'vitest';
import { filmLabel, filmstripLayout, FILM_COLUMNS, FILM_TILE_WIDTH } from './design-filmstrip';

describe('the filmstrip layout', () => {
  it('scales every frame to one tile width and keeps its proportions', () => {
    const layout = filmstripLayout([{ width: 1440, height: 900 }]);
    expect(layout.tiles[0]).toEqual({ x: 12, y: 12 + 22, width: FILM_TILE_WIDTH, height: Math.round((900 * FILM_TILE_WIDTH) / 1440) });
  });

  it('lays frames out in rows of four, each row as tall as its tallest tile', () => {
    const sizes = [1, 2, 3, 4, 5].map(() => ({ width: 1440, height: 900 }));
    const layout = filmstripLayout(sizes);
    expect(layout.tiles.map((tile) => tile.x)).toEqual([12, 12 + 372, 12 + 744, 12 + 1116, 12]);
    expect(layout.tiles[4].y).toBeGreaterThan(layout.tiles[0].y);
    expect(layout.width).toBe(12 + FILM_COLUMNS * (FILM_TILE_WIDTH + 12));
  });

  it('is empty for no frames', () => {
    expect(filmstripLayout([])).toEqual({ width: 12 + 0, height: 0, tiles: [] });
  });

  it('labels each frame with its instant', () => {
    expect(filmLabel(0)).toBe('t = 0ms');
    expect(filmLabel(333.4)).toBe('t = 333ms');
  });
});
