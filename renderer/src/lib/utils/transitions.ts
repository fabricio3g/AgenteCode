// OpenWebUI-inspired flyAndScale transition
import { cubicOut } from 'svelte/easing';
import type { TransitionConfig } from 'svelte/transition';

interface FlyAndScaleParams {
  y?: number;
  x?: number;
  start?: number;
  duration?: number;
}

export function flyAndScale(
  node: Element,
  params?: FlyAndScaleParams
): TransitionConfig {
  const style = getComputedStyle(node);
  const transform = style.transform === 'none' ? '' : style.transform;
  const p = { y: -8, x: 0, start: 0.95, duration: 200, ...params };

  return {
    duration: p.duration,
    delay: 0,
    easing: cubicOut,
    css: (t) => {
      const y = (1 - t) * p.y;
      const x = (1 - t) * p.x;
      const scale = p.start + t * (1 - p.start);
      return `transform: ${transform} translate3d(${x}px, ${y}px, 0) scale(${scale});`;
    }
  };
}
