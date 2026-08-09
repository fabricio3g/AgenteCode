import { fade, fly, slide } from 'svelte/transition'
import type { FadeParams, FlyParams, SlideParams, TransitionConfig } from 'svelte/transition'
import { reducedMotion } from '$lib/utils/motion.svelte'

const productEase = (t: number): number => {
  const inverse = 1 - t
  return 1 - inverse * inverse * inverse
}

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
    easing: productEase,
    css: (t) => {
      const y = (1 - t) * p.y
      const x = (1 - t) * p.x
      const scale = p.start + t * (1 - p.start)
      return `transform: ${transform} translate3d(${x}px, ${y}px, 0) scale(${scale});`
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
  return slide(node, { duration: 180, easing: productEase, ...params })
}
