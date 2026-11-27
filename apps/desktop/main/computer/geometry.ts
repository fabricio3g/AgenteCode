export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface DisplayGeometry {
  displayId: number;
  bounds: Rect;
  scale: number;
  physical: Rect;
  protected?: Rect;
}

export interface DisplayLike {
  id: number;
  bounds: Rect;
  scaleFactor: number;
}

export function computePhysicalRect(bounds: Rect, dipToScreenPoint: (point: Point) => Point): Rect {
  const start = dipToScreenPoint({ x: bounds.x, y: bounds.y });
  const end = dipToScreenPoint({ x: bounds.x + bounds.width - 1, y: bounds.y + bounds.height - 1 });
  return {
    x: start.x,
    y: start.y,
    width: Math.max(1, end.x - start.x + 1),
    height: Math.max(1, end.y - start.y + 1),
  };
}

/**
 * Map an observation-image coordinate back into physical screen pixels for the
 * observed display, clamping to `[rect.x, rect.x + rect.width - 1]` so
 * mixed-DPI rounding or 4096px screenshot capping never drifts outside the display.
 */
export function mapObservationPoint(
  x: number,
  y: number,
  observation: { width: number; height: number },
  rect: Rect,
): Point | null {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= observation.width || y >= observation.height) {
    return null;
  }
  const rawX = rect.x + Math.round((x * Math.max(0, rect.width - 1)) / Math.max(1, observation.width - 1));
  const rawY = rect.y + Math.round((y * Math.max(0, rect.height - 1)) / Math.max(1, observation.height - 1));
  return {
    x: Math.max(rect.x, Math.min(rect.x + rect.width - 1, rawX)),
    y: Math.max(rect.y, Math.min(rect.y + rect.height - 1, rawY)),
  };
}

export function classifyDisplayChange(
  active: DisplayGeometry | undefined,
  event: 'added' | 'removed' | 'metrics',
  currentDisplays: readonly DisplayLike[],
  changedDisplayId?: number,
  metrics?: readonly string[],
  toPhysical?: (bounds: Rect, scale: number) => Rect,
): 'takeover' | 'invalidate' | 'ignore' {
  if (!active) return 'ignore';
  const current = currentDisplays.find((display) => display.id === active.displayId);
  if (!current) return 'takeover';

  const boundsChanged =
    current.bounds.x !== active.bounds.x ||
    current.bounds.y !== active.bounds.y ||
    current.bounds.width !== active.bounds.width ||
    current.bounds.height !== active.bounds.height;
  const scaleChanged = current.scaleFactor !== active.scale;
  const physicalChanged = toPhysical
    ? (() => {
        const next = toPhysical(current.bounds, current.scaleFactor);
        return (
          next.x !== active.physical.x ||
          next.y !== active.physical.y ||
          next.width !== active.physical.width ||
          next.height !== active.physical.height
        );
      })()
    : false;

  if (boundsChanged || scaleChanged || physicalChanged) return 'takeover';

  if (event === 'metrics') {
    if (changedDisplayId !== undefined && changedDisplayId !== active.displayId) return 'ignore';
    if (changedDisplayId === active.displayId && metrics?.some((m) => m === 'bounds' || m === 'scaleFactor' || m === 'rotation')) {
      return 'takeover';
    }
    return 'ignore';
  }

  return 'invalidate';
}
