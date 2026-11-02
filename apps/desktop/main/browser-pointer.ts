import { AGENT_POINTER_SVG } from '../shared/agent-pointer.ts';

/** Restyle the real page cursor; the click ring is not a second mouse. */
export function browserPointerScript(x: number, y: number, pressed: boolean, scale = 1, pulse = false): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'undefined';
  const size = 1 / Math.max(0.1, Math.min(1, scale));
  const cursor = `url("data:image/svg+xml,${encodeURIComponent(AGENT_POINTER_SVG)}") 3 3, auto`;
  return `(() => {
    let style = document.getElementById('__agente_cursor_style');
    if (!style) { style = document.createElement('style'); style.id = '__agente_cursor_style'; document.documentElement.appendChild(style); }
    style.textContent = ${JSON.stringify(`html,body,*{cursor:${cursor}!important}`)};
    let host = document.getElementById('__agente_pointer');
    if (!host) {
      host = document.createElement('div'); host.id = '__agente_pointer'; host.setAttribute('aria-hidden','true');
      host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;';
      host.attachShadow({mode:'open'}).innerHTML = '<style>.ring{position:absolute;width:calc(24px * var(--pointer-scale));height:calc(24px * var(--pointer-scale));left:calc(-12px * var(--pointer-scale));top:calc(-12px * var(--pointer-scale));border:2px solid #b96c43;border-radius:50%;opacity:0}.ring.on{opacity:.7}@media(prefers-reduced-motion:no-preference){.ring.pulse{animation:p .5s ease-out infinite}@keyframes p{from{opacity:.7;transform:scale(.8)}to{opacity:0;transform:scale(1.8)}}}</style><span class="ring"></span>';
      document.documentElement.appendChild(host);
    }
    host.style.setProperty('--pointer-scale', '${size}');
    host.style.transform = 'translate(${Math.round(x)}px, ${Math.round(y)}px)'; host.style.opacity = '1';
    const ring = host.shadowRoot.querySelector('.ring');
    ring.classList.toggle('on', ${pressed}); ring.classList.toggle('pulse', ${pulse});
    clearTimeout(window.__agentePointerTimer);
    window.__agentePointerTimer = setTimeout(() => {host.style.opacity='0';style.remove();},3500);
  })()`;
}
