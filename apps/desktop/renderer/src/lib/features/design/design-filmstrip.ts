/**
 * The frames of one motion capture, tiled into a single picture for a vision
 * model: each frame scaled to one width, labelled with its time, a few to a row.
 * The layout is pure; drawing it is the one DOM step at the end.
 */

export const FILM_TILE_WIDTH = 360;
export const FILM_COLUMNS = 4;

export interface FilmTile { x: number; y: number; width: number; height: number }
export interface FilmLayout { width: number; height: number; tiles: FilmTile[] }

/**
 * Where each frame goes. Every tile is `tileWidth` wide and keeps its frame's
 * proportions; a label strip sits above each tile, and rows are as tall as the
 * tallest tile in them.
 */
export function filmstripLayout(sizes: Array<{ width: number; height: number }>, tileWidth = FILM_TILE_WIDTH, columns = FILM_COLUMNS, gap = 12, label = 22): FilmLayout {
  const cells = sizes.map((size) => ({ width: tileWidth, height: Math.max(1, Math.round((size.height * tileWidth) / Math.max(1, size.width))) }));
  const rows: number[] = [];
  cells.forEach((cell, index) => {
    const row = Math.floor(index / columns);
    rows[row] = Math.max(rows[row] ?? 0, cell.height);
  });
  const rowTop: number[] = [];
  let top = gap;
  rows.forEach((height, row) => {
    rowTop[row] = top;
    top += label + height + gap;
  });
  const tiles = cells.map((cell, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return { x: gap + column * (tileWidth + gap), y: rowTop[row] + label, width: cell.width, height: cell.height };
  });
  const usedColumns = Math.min(columns, cells.length);
  return {
    width: gap + usedColumns * (tileWidth + gap),
    height: cells.length ? top : 0,
    tiles
  };
}

/** The label drawn above a tile: the frame's instant, as the model reads times elsewhere. */
export const filmLabel = (t: number) => `t = ${Math.round(t)}ms`;

/** Tiles the frames into one PNG (base64). Frames that fail to decode are left out of the picture rather than failing the turn. */
export async function composeFilmstrip(frames: Array<{ t: number; png: string }>): Promise<{ png: string; width: number; height: number } | null> {
  const images = await Promise.all(frames.map(async (frame) => {
    const image = new Image();
    image.src = `data:image/png;base64,${frame.png}`;
    try {
      await image.decode();
      return image;
    } catch {
      return null;
    }
  }));
  const shown = images.map((image, index) => ({ image, t: frames[index].t })).filter((item): item is { image: HTMLImageElement; t: number } => item.image !== null);
  if (!shown.length) return null;
  const layout = filmstripLayout(shown.map(({ image }) => ({ width: image.naturalWidth, height: image.naturalHeight })));
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#4b4b4b';
  context.font = '14px system-ui, sans-serif';
  shown.forEach(({ image, t }, index) => {
    const tile = layout.tiles[index];
    context.fillText(filmLabel(t), tile.x, tile.y - 6);
    context.strokeStyle = '#d9d9d9';
    context.strokeRect(tile.x - 0.5, tile.y - 0.5, tile.width + 1, tile.height + 1);
    context.drawImage(image, tile.x, tile.y, tile.width, tile.height);
  });
  return { png: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), width: canvas.width, height: canvas.height };
}
