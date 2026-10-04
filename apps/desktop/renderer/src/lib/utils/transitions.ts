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

/** Ease-in for leaving: starts gently, then gets out of the way. */
const exitEase = (t: number): number => t * t * t

/**
 * Dialogs share a short transform/opacity transition. Text stays sharp
 * throughout; animating a blur forces repeated rasterization of the panel.
 */
export function dialogIn(_node: Element): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return {
    duration: 200,
    easing: smoothEase,
    css: (t, u) =>
      `opacity: ${Math.min(1, t * 1.8)}; transform: translate3d(0, ${u * 6}px, 0) scale(${0.985 + t * 0.015});`
  }
}

/** A dialog leaving: quicker than it came, a slight drop and shrink as it fades. */
export function dialogOut(_node: Element): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return {
    duration: 160,
    easing: exitEase,
    css: (t, u) => `opacity: ${t}; transform: translate3d(0, ${u * 6}px, 0) scale(${1 - u * 0.025});`
  }
}

/** The backdrop behind a dialog: it fades in with the dialog and out a touch faster. */
export function backdropIn(_node: Element): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return { duration: 150, easing: smoothEase, css: (t) => `opacity: ${t};` }
}

export function backdropOut(_node: Element): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return { duration: 150, easing: exitEase, css: (t) => `opacity: ${t};` }
}

export function motionFade(
  node: Element,
  params: FadeParams | undefined
): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return fade(node, { duration: 150, easing: smoothEase, ...params })
}

export function motionFly(
  node: Element,
  params: FlyParams | undefined
): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return fly(node, { duration: 200, easing: smoothEase, ...params })
}

export function motionSlide(
  node: Element,
  params: SlideParams | undefined
): TransitionConfig {
  if (reducedMotion.value) return { duration: 0, css: () => '' }
  return slide(node, { duration: 180, easing: smoothEase, ...params })
}
