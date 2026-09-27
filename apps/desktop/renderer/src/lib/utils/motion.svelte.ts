export const reducedMotion = $state({ value: false })

export function initMotion(): void {
  const update = () => {
    reducedMotion.value =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      window.matchMedia('(max-width: 768px)').matches ||
      window.matchMedia('(pointer: coarse)').matches
  }
  update()
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', update)
  window.matchMedia('(max-width: 768px)').addEventListener('change', update)
  window.matchMedia('(pointer: coarse)').addEventListener('change', update)
}
