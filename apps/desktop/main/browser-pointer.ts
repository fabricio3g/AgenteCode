/** A decorative agent cursor in the guest page; never intercepts page input. */
export function browserPointerScript(x: number, y: number, pressed: boolean, scale = 1, pulse = false): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'undefined';
  const size = 1 / Math.max(0.1,Math.min(1,scale));
  return `(() => {
    let host = document.getElementById('__agente_pointer');
    if (!host) {
      host = document.createElement('div'); host.id = '__agente_pointer'; host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;contain:layout style;';
      host.dataset.fresh = '1';
      const root = host.attachShadow({mode:'open'});
      root.innerHTML = '<style>:host{pointer-events:none}svg{display:block;width:calc(22px * var(--pointer-scale));height:calc(28px * var(--pointer-scale));filter:drop-shadow(0 1px 2px #0008)}.ring{position:absolute;width:calc(24px * var(--pointer-scale));height:calc(24px * var(--pointer-scale));left:calc(-12px * var(--pointer-scale));top:calc(-12px * var(--pointer-scale));border:2px solid #e8793a;border-radius:50%;opacity:0;box-sizing:border-box}.ring.on{opacity:1;transform:scale(1.5)}@media(prefers-reduced-motion:no-preference){.ring{transition:opacity .15s,transform .2s}.ring.pulse{animation:p .5s ease-out infinite}@keyframes p{from{opacity:1;transform:scale(.8)}to{opacity:0;transform:scale(1.8)}}}</style><span class="ring"></span><svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2v21l5-5 4 8 4-2-4-8h8z" fill="#e8793a" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(host);
    }
    host.style.setProperty('--pointer-scale', '${size}');
    const fresh = host.dataset.fresh === '1';
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    host.style.transition = fresh || calm ? 'none' : 'transform .22s cubic-bezier(.2,.7,.2,1), opacity .2s';
    host.style.transform = 'translate(${Math.round(x)}px, ${Math.round(y)}px)'; host.style.opacity = '1';
    if (fresh) { host.getBoundingClientRect(); delete host.dataset.fresh; }
    const ring = host.shadowRoot.querySelector('.ring');
    ring.classList.toggle('on', ${pressed});
    ring.classList.toggle('pulse', ${pulse});
    clearTimeout(window.__agentePointerTimer);
    window.__agentePointerTimer = setTimeout(() => { host.style.opacity = '0'; }, 3500);
  })()`;
}
