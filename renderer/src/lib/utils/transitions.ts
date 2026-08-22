import { fade, fly, slide } from 'svelte/transition'
import type { FadeParams, FlyParams, SlideParams, TransitionConfig } from 'svelte/transition'
import { reducedMotion } from '$lib/utils/motion.svelte'

/*
 * Expo-out: fast attack, long settle. The signature ease of the smooth-UI
 * class (Linear and peers) — motion answers immediately, then glides to rest.
 */
export const smoothEase = (t: number): number => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t))

interface FlyAndScaleParams {
  y?: number
  x?: number
  start?: number
  duration?: number
}

export function flyAndScale(
  node: Element,
  params?: FlyAndScaleParams
): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  const style = getComputedStyle(node)
  const transform = style.transform === 'none' ? '' : style.transform
  const p = { y: -8, x: 0, start: 0.95, duration: 200, ...params }

  return {
    duration: p.duration,
    delay: 0,
    easing: smoothEase,
    css: (t) => {
      const y = (1 - t) * p.y
      const x = (1 - t) * p.x
      const scale = p.start + t * (1 - p.start)
      return `opacity: ${Math.min(1, t * 1.6)}; transform: ${transform} translate3d(${x}px, ${y}px, 0) scale(${scale});`
    }
  }
}

export function motionFade(
  node: Element,
  params: FadeParams | undefined
): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return fade(node, params)
}

export function motionFly(
  node: Element,
  params: FlyParams | undefined
): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return fly(node, params)
}

export function motionSlide(
  node: Element,
  params: SlideParams | undefined
): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return slide(node, { duration: 180, easing: smoothEase, ...params })
}
