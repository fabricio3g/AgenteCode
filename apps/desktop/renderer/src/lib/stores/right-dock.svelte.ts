// The right dock: the side panels (Changes, the agent browser, an open
// artifact) share one column. Its width, and how tall each stacked panel is
// (as a weight), are remembered on this computer.

const KEY = 'agente.rightDock';
const MIN_WIDTH = 320;
/** Smallest share of the column a stacked panel keeps. */
const MIN_WEIGHT = 0.15;

interface DockLayout {
  width: number;
  /** Relative heights of stacked panels, by panel id. */
  weights: Record<string, number>;
}

/** Stored JSON → layout; anything missing or broken falls back. */
export function parseLayout(raw: string | null): DockLayout {
  let saved: Partial<DockLayout> = {};
  try {
    saved = JSON.parse(raw || '{}') as Partial<DockLayout>;
  } catch {
    // Broken JSON: start over.
  }
  const width = Number(saved.width);
  return { width: Number.isFinite(width) && width > 0 ? width : 460, weights: { ...(saved.weights ?? {}) } };
}

function read(): DockLayout {
  try {
    return parseLayout(localStorage.getItem(KEY));
  } catch {
    return parseLayout(null);
  }
}

/** Move `delta` (a share of the column) from panel b to panel a, keeping both above the minimum. */
export function shiftWeights(a: number, b: number, delta: number): [number, number] {
  const total = a + b;
  const next = Math.min(total - MIN_WEIGHT * total, Math.max(MIN_WEIGHT * total, a + delta));
  return [next, total - next];
}

class RightDockStore {
  layout = $state<DockLayout>(read());

  #save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.layout));
    } catch {
      // Blocked storage: the layout lasts for this session.
    }
  }

  weight(id: string): number {
    return this.layout.weights[id] ?? 1;
  }

  setWidth(px: number) {
    const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.7));
    this.layout = { ...this.layout, width: Math.round(Math.min(max, Math.max(MIN_WIDTH, px))) };
    this.#save();
  }

  setWeights(weights: Record<string, number>) {
    this.layout = { ...this.layout, weights: { ...this.layout.weights, ...weights } };
    this.#save();
  }
}

export const rightDock = new RightDockStore();
