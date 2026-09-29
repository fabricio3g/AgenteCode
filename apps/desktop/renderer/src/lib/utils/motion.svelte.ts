export const reducedMotion = $state({ value: false })

/** Settings → Accessibility: follow the system, or force motion on or off. */
let preference: 'system' | 'on' | 'off' = 'system'
let update = () => {}

export function setMotionPreference(next: 'system' | 'on' | 'off'): void {
  preference = next
  update()
}

export function initMotion(): void {
  update = () => {
    const small =
      window.matchMedia('(max-width: 768px)').matches ||
      window.matchMedia('(pointer: coarse)').matches
    const system = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    reducedMotion.value = preference === 'on' || small || (preference === 'system' && system)
  }
  update()
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', update)
  window.matchMedia('(max-width: 768px)').addEventListener('change', update)
  window.matchMedia('(pointer: coarse)').addEventListener('change', update)
}
