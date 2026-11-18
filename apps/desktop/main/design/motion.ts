/**
 * Motion for the Design agent, from what the render window measured. This
 * module is pure: render.ts drives the offline guest and gathers the frames and
 * the animation list; these functions choose the instants to capture and shape
 * what the model reads back.
 */
import type { DesignAnimation, DesignFrame, DesignMotionSample } from '../../shared/design.ts';

const FRAME_LIMITS = { frames: { min: 2, max: 8, fallback: 4 }, durationMs: { min: 1, max: 3000, fallback: 600 } } as const;

const clampNumber = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** The instants a capture takes: the first at 0, the last at the span, evenly between. */
export function frameTimes(frames: unknown, durationMs: unknown): number[] {
  const count = Math.round(clampNumber(frames, FRAME_LIMITS.frames.min, FRAME_LIMITS.frames.max, FRAME_LIMITS.frames.fallback));
  const span = clampNumber(durationMs, FRAME_LIMITS.durationMs.min, FRAME_LIMITS.durationMs.max, FRAME_LIMITS.durationMs.fallback);
  return Array.from({ length: count }, (_, index) => Math.round((span * index) / (count - 1)));
}

/** A duration as the model reads it: `320ms`, `1.2s`. */
export function formatMs(ms: number): string {
  if (ms >= 1000) return `${Number((ms / 1000).toFixed(2))}s`;
  return `${Math.round(ms)}ms`;
}

/** One animation as one line: what changes, how long, the easing and how often it repeats. */
export function describeAnimation(animation: DesignAnimation): string {
  const props = animation.properties.length ? animation.properties.join(', ') : 'nothing listed';
  const what = animation.kind === 'animation' ? `keyframe animation "${animation.name}" (${props})` : animation.kind === 'transition' ? `transition of ${props}` : `script animation of ${props}`;
  const repeat = animation.iterations === 'infinite' ? 'repeats forever' : animation.iterations === 1 ? 'plays once' : `${animation.iterations} iterations`;
  const delay = animation.delayMs > 0 ? `, after a ${formatMs(animation.delayMs)} delay` : '';
  return `- ${animation.selector}: ${what}, ${formatMs(animation.durationMs)}${delay}, easing ${animation.easing}, ${repeat}`;
}

/**
 * What design_motion returns: the list, then the reduced-motion verdict. A null
 * `reducedRunning` means the check was not run.
 */
export function motionReport(input: { animations: DesignAnimation[]; reducedRunning: DesignAnimation[] | null; hovered?: string; focused?: string }): string {
  const trigger = input.hovered ? ` after hovering ${input.hovered}` : input.focused ? ` after focusing ${input.focused}` : '';
  const lines = [
    input.animations.length ? `${input.animations.length} animation(s) on the page${trigger}:` : `No animations or transitions on the page${trigger}.`,
    ...input.animations.map(describeAnimation)
  ];
  if (input.reducedRunning === null) lines.push('Reduced motion: not checked.');
  else if (input.reducedRunning.length === 0) lines.push('Reduced motion: every animation stops or is removed when the user prefers reduced motion.');
  else {
    lines.push(`Reduced motion: ${input.reducedRunning.length} animation(s) still run when the user prefers reduced motion. Put them behind @media (prefers-reduced-motion: no-preference), or switch them off in a reduce block:`);
    lines.push(...input.reducedRunning.map(describeAnimation));
  }
  return lines.join('\n');
}

const sampleLine = (sample: DesignMotionSample) =>
  `y=${sample.box.y} x=${sample.box.x} ${sample.box.width}×${sample.box.height} opacity=${sample.opacity} transform=${sample.transform.length > 60 ? `${sample.transform.slice(0, 57)}…` : sample.transform}`;

/**
 * The non-vision view of a capture: each element whose box, opacity or transform
 * differs between the frames, with its value at every instant. Elements that
 * stay put are left out, so a quiet page reads as quiet.
 */
export function frameOutline(frames: DesignFrame[]): string {
  if (frames.length < 2) return 'Only one frame was captured, so there is no motion to compare.';
  const times = frames.map((frame) => `${Math.round(frame.t)}ms`).join(', ');
  const perSelector = new Map<string, Array<DesignMotionSample | undefined>>();
  frames.forEach((frame, index) => {
    for (const sample of frame.samples) {
      const row = perSelector.get(sample.selector) ?? frames.map(() => undefined);
      row[index] = sample;
      perSelector.set(sample.selector, row);
    }
  });
  const moving: string[] = [];
  for (const [selector, row] of perSelector) {
    const seen = row.filter((sample): sample is DesignMotionSample => sample !== undefined).map((sample) => JSON.stringify([sample.box, sample.opacity, sample.transform]));
    if (new Set(seen).size < 2) continue;
    moving.push(`- ${selector}`);
    frames.forEach((frame, index) => {
      const sample = row[index];
      moving.push(`  t=${Math.round(frame.t)}ms: ${sample ? sampleLine(sample) : 'not on the page'}`);
    });
  }
  const header = `Captured ${frames.length} frames at ${times}. Only elements whose box, opacity or transform changed are listed.`;
  return moving.length ? [header, ...moving].join('\n') : `${header}\nNothing moved: the page is still across these frames.`;
}
