/**
 * The Agente Code mark, as data.
 *
 * `crates/agente-tui/examples/gen_brand.rs` draws the brand icon: a tilted
 * Quasar Orbital (-28°) rendered as a 15×15 shaded Matrix Field of
 * rounded-square tiles (`rx = 0.22 * size`) on a black rounded tile inside a
 * graphite rim. The startup screen lights those tiles individually, so this is
 * the same field — the same luminance function, the same 15×15 grid, the same
 * shading ladder — evaluated once at module load on the icon's 120×120 grid.
 *
 * Each tile also carries its place in the orbit: its angle in the disk's own
 * ellipse, turned into a negative animation delay so a highlight can run
 * around the accretion ring the moment the screen paints.
 */

/** Quasar tilt in degrees (ascending bottom-left → top-right). */
const QUASAR_ANGLE_DEG = -28;

/** 15×15 cells with a 9-unit pad, as in the generator. */
const GRID = 15;
const PAD = 9;
const STEP = (120 - PAD * 2) / GRID;

/** Semi-axes of the tilted accretion ellipse, in the quasar's own frame. */
const DISK_U = 0.84;
const DISK_V = 0.29;

/** Four corner star specks, kept dim so the mark has a constellation. */
const STARS: ReadonlyArray<readonly [row: number, col: number, luminance: number]> = [
  [2, 12, 0.42],
  [2, 2, 0.34],
  [12, 12, 0.36],
  [12, 2, 0.34],
];

/** One full orbital revolution, shared by every tile's delay. */
export const QUASAR_ORBIT_PERIOD = 3.6;

/** How long the field takes to light up, horizon to edge, before the orbit reads. */
export const QUASAR_ASSEMBLY = 0.55;

export interface QuasarTile {
  /** Left edge on the 120×120 icon grid. */
  x: number;
  /** Top edge on the 120×120 icon grid. */
  y: number;
  /** Side of the rounded square. */
  size: number;
  /** Corner radius (`0.22 * size`). */
  rx: number;
  /** The brand's shading for this tile, 0.62–1. */
  opacity: number;
  /** Negative animation delay, in seconds: the sweep is already in orbit. */
  delay: number;
  /** When the tile lights up on launch, in seconds: the horizon first, the edge last. */
  enter: number;
}

/** Normalized tilted Quasar Orbital luminance field, in [-1, 1]². */
export function quasarOrbitalField(nx: number, ny: number): number {
  const rad = (QUASAR_ANGLE_DEG * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const u = nx * cos + ny * sin;
  const v = -nx * sin + ny * cos;
  const r = Math.hypot(u, v);

  const voidR = 0.21;
  if (r < voidR) return 0;

  // Luminous photon ring hugging the circular event horizon.
  const ring = Math.exp(-(((r - (voidR + 0.095)) / 0.115) ** 2)) * 1.24;

  // Tilted hollow elliptical accretion ring.
  const ed = Math.hypot(u / DISK_U, v / DISK_V);
  const outerRing = Math.exp(-(((ed - 1) / 0.24) ** 2)) * 1.15;
  const innerGlow = Math.exp(-((v / 0.14) ** 2)) * Math.exp(-((u / 0.45) ** 2)) * 0.45;
  const disk = Math.max(outerRing, innerGlow);

  // Twin perpendicular relativistic jets.
  const jetWidth = 0.092 * (0.72 + 0.38 * Math.exp(-Math.abs(v) * 2));
  const jet = Math.exp(-((u / jetWidth) ** 2)) * Math.exp(-((v / 0.94) ** 2) * 0.82) * 1.12;

  return Math.min(
    1,
    Math.max(ring, disk * 0.98 + jet * 0.98, ring * 0.78 + disk * 0.56 + jet * 0.56),
  );
}

const round = (n: number) => Math.round(n * 100) / 100;

function build(): QuasarTile[] {
  const rad = (QUASAR_ANGLE_DEG * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const tiles: QuasarTile[] = [];

  for (let row = 0; row < GRID; row += 1) {
    for (let col = 0; col < GRID; col += 1) {
      const cx = PAD + (col + 0.5) * STEP;
      const cy = PAD + (row + 0.5) * STEP;
      const nx = (cx - 60) / 51;
      const ny = (cy - 60) / 51;
      let value = quasarOrbitalField(nx, ny);
      let star = false;

      for (const [starRow, starCol, luminance] of STARS) {
        if (row === starRow && col === starCol && value < luminance) {
          value = luminance;
          star = true;
        }
      }
      if (value < 0.15) continue;

      const q = value > 0.78 ? 0.9 : value > 0.58 ? 0.75 : value > 0.4 ? 0.58 : value > 0.25 ? 0.42 : 0.28;
      const size = STEP * q;
      const opacity = star ? 0.72 : value > 0.58 ? 1 : value > 0.34 ? 0.85 : 0.62;

      // A tile's place in the orbit is its angle in the disk's own ellipse,
      // not on screen: the ends are compressed in screen angle, and a screen
      // angle would bunch the light there while racing past the sides.
      const u = nx * cos + ny * sin;
      const v = -nx * sin + ny * cos;
      const turn = (Math.atan2(v / DISK_V, u / DISK_U) + Math.PI) / (2 * Math.PI);

      // Launch lights the field from the event horizon outward: a ripple, so
      // the mark assembles rather than fading in as one picture.
      const reach = Math.min(1, Math.max(0, (Math.hypot(nx, ny) - 0.2) / 1.05));

      tiles.push({
        x: round(cx - size / 2),
        y: round(cy - size / 2),
        size: round(size),
        rx: round(size * 0.22),
        opacity,
        delay: round((turn - 1) * QUASAR_ORBIT_PERIOD),
        enter: round(reach * QUASAR_ASSEMBLY),
      });
    }
  }

  return tiles;
}

const TILES = build();

/** The mark's tiles, in drawing order. */
export function quasarTiles(): readonly QuasarTile[] {
  return TILES;
}
