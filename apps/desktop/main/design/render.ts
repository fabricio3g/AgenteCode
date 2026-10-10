/**
 * Renders a design page in the offline artifact guest and reports what it
 * looks like: a PNG for vision models, a compact outline for the rest, or the
 * measured boxes and styles of a selector. The guest has no network, no
 * preload and no navigation (see `artifact-preview.ts`); this module only
 * drives it.
 */
import type { BrowserWindow } from 'electron';
import { createArtifactWindow, loadArtifactHtml, withArtifactTimeout } from '../artifact-preview.ts';
import type { DesignAnimation, DesignFrame, DesignMotionSample, DesignRenderRequest, DesignRenderResult } from '../../shared/design.ts';
import { frameOutline, frameTimes, motionReport } from './motion.ts';

const MAX_FULL_PAGE = 4000;
const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Runs first in the page: collects script errors so the agent hears about them. */
const ERROR_PROBE = `<script>(function(){var e=window.__designErrors=[];var add=function(m){if(e.length<12)e.push(String(m).slice(0,240))};addEventListener('error',function(v){add(v.message+(v.lineno?' (line '+v.lineno+')':''))});addEventListener('unhandledrejection',function(v){add('Unhandled rejection: '+(v.reason&&v.reason.message||v.reason))});var ce=console.error;console.error=function(){add(Array.prototype.join.call(arguments,' '));ce.apply(console,arguments)}})();</script>`;

const SETTLE_SCRIPT = `Promise.race([
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(function(){ return new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); }); }),
  new Promise(function(r){ setTimeout(r, 1500); })
]).then(function(){ return { height: document.documentElement.scrollHeight, errors: window.__designErrors || [] }; })`;

/** One element's label (`div#app.shell`), shared by the guest scripts that name elements. */
const LABEL_FN = `function label(el){ var s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; var c = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0,2).join('.') : ''; return c ? s + '.' + c : s; }`;

/** A compact picture of the page for models that cannot see it: one line per meaningful element. */
const OUTLINE_SCRIPT = `(function(){
  var SKIP = /^(SCRIPT|STYLE|META|LINK|HEAD|TITLE|NOSCRIPT|BR|TEMPLATE|PATH|DEFS)$/;
  var KEEP = /^(IMG|SVG|BUTTON|A|INPUT|SELECT|TEXTAREA|NAV|HEADER|FOOTER|MAIN|SECTION|ARTICLE|ASIDE|FORM|UL|OL|TABLE|H[1-6])$/;
  var lines = [], vw = innerWidth, q = Math.round;
  ${LABEL_FN}
  function own(el){ var t = ''; for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) t += ' ' + n.textContent; return t.replace(/\\s+/g,' ').trim().slice(0,70); }
  function walk(el, depth){
    if (lines.length >= 140 || depth > 8 || SKIP.test(el.tagName)) return;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    var r = el.getBoundingClientRect(), text = own(el);
    if ((depth <= 2 || text || KEEP.test(el.tagName)) && r.width > 0 && r.height > 0) {
      var line = new Array(depth + 1).join('  ') + label(el) + ' [' + q(r.x) + ',' + q(r.y + scrollY) + ' ' + q(r.width) + 'x' + q(r.height) + ']';
      if (text) line += ' "' + text + '" ' + cs.fontSize + '/' + cs.fontWeight + ' ' + cs.color;
      if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') line += ' bg ' + cs.backgroundColor;
      if (r.right > vw + 1) line += ' OVERFLOWS-X';
      lines.push(line);
    }
    for (var i = 0; i < el.children.length; i++) walk(el.children[i], depth + 1);
  }
  walk(document.body, 0);
  return { lines: lines, truncated: lines.length >= 140, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, viewport: vw };
})()`;

const inspectScript = (selector: string) => `(function(){
  var PROPS = ['display','position','color','background-color','font-family','font-size','font-weight','line-height','margin','padding','border','border-radius','gap','opacity','overflow','z-index'];
  var list; try { list = document.querySelectorAll(${JSON.stringify(selector)}); } catch (e) { return { error: 'Invalid selector: ' + e.message }; }
  var out = [];
  for (var i = 0; i < Math.min(list.length, 8); i++) {
    var el = list[i], r = el.getBoundingClientRect(), cs = getComputedStyle(el), styles = {};
    PROPS.forEach(function(p){ styles[p] = cs.getPropertyValue(p); });
    out.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,80),
      box: { x: Math.round(r.x), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
      overflowsX: el.scrollWidth > el.clientWidth + 1, styles: styles });
  }
  return { count: list.length, matches: out };
})()`;

/** Every animation and transition on the page, with what it targets, changes and how it is timed. */
const ANIMATION_SCRIPT = `(function(){
  var SKIP = ['offset', 'computedOffset', 'easing', 'composite'];
  ${LABEL_FN}
  var list = document.getAnimations(), out = [];
  for (var i = 0; i < list.length && out.length < 80; i++) {
    var a = list[i], fx = a.effect;
    if (!fx) continue;
    var timing = fx.getComputedTiming(), props = [];
    try { fx.getKeyframes().forEach(function(k){ Object.keys(k).forEach(function(p){ if (SKIP.indexOf(p) < 0 && props.indexOf(p) < 0) props.push(p); }); }); } catch (e) {}
    var kind = typeof CSSTransition !== 'undefined' && a instanceof CSSTransition ? 'transition' : typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation ? 'animation' : 'script';
    if (kind === 'transition' && a.transitionProperty) props = [a.transitionProperty];
    out.push({ selector: fx.target ? label(fx.target) : '(no element)', kind: kind, name: kind === 'animation' ? String(a.animationName || '') : '', properties: props.slice(0, 8),
      durationMs: Math.round(Number(timing.duration) || 0), delayMs: Math.round(Number(timing.delay) || 0),
      iterations: timing.iterations === Infinity ? 'infinite' : Number(timing.iterations) || 1, easing: String(timing.easing || 'linear'), playState: a.playState });
  }
  return out;
})()`;

/** Where each animated element is and how it looks at this instant. */
const SAMPLE_SCRIPT = `(function(){
  var out = [], seen = [], list = document.getAnimations();
  ${LABEL_FN}
  for (var i = 0; i < list.length && out.length < 60; i++) {
    var el = list[i].effect && list[i].effect.target;
    if (!el || seen.indexOf(el) >= 0) continue;
    seen.push(el);
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    out.push({ selector: label(el), box: { x: Math.round(r.left), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }, opacity: cs.opacity, transform: cs.transform });
  }
  return out;
})()`;

/** Pins every animation at one instant, so a capture shows exactly that moment. */
const seekScript = (ms: number) => `(function(){var list=document.getAnimations();for(var i=0;i<list.length;i++){list[i].pause();list[i].currentTime=${Math.round(ms)};}return list.length;})()`;

/**
 * Two frames of painting. A hidden guest does not always run requestAnimationFrame,
 * so the wait is raced against a short timer rather than trusted to it.
 */
const paint = (win: BrowserWindow) =>
  win.webContents.executeJavaScript(`new Promise(function(r){var done=false;function f(){if(!done){done=true;r()}}requestAnimationFrame(function(){requestAnimationFrame(f)});setTimeout(f,120)})`, false);

/**
 * The page's state before a capture: scroll, focus, or hover over a selector.
 * Returns an error message when a selector is invalid. With `settle`, the
 * transitions the state starts are run to their end first (a still picture
 * of a hover shows the hovered page, not its middle).
 */
async function triggerState(win: BrowserWindow, request: DesignRenderRequest, settle = false): Promise<string | null> {
  if (request.scrollTo !== undefined && Number.isFinite(request.scrollTo)) {
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${Math.max(0, Math.round(request.scrollTo))})`, false);
  }
  const target = request.hover ?? request.focus;
  if (!target) return null;
  const found = await win.webContents.executeJavaScript(`(function(){
    try {
      var el = document.querySelector(${JSON.stringify(target)});
      if (!el) return { missing: true };
      if (${JSON.stringify(Boolean(request.focus && !request.hover))}) { el.focus({ preventScroll: true }); return { focused: true }; }
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    } catch (e) { return { invalid: String(e.message || e) }; }
  })()`, false) as { missing?: boolean; invalid?: string; focused?: boolean; x?: number; y?: number };
  if (found.invalid) return `Invalid selector: ${found.invalid}`;
  if (found.missing) return `No element matches ${target}.`;
  if (found.x !== undefined && found.y !== undefined) win.webContents.sendInputEvent({ type: 'mouseMove', x: found.x, y: found.y });
  if (settle) {
    await win.webContents.executeJavaScript(`Promise.race([Promise.all(document.getAnimations().map(function(a){return a.finished.catch(function(){})})), new Promise(function(r){setTimeout(r,1500)})])`, false);
  }
  return null;
}

/** The stage's current picture as base64 PNG; an offscreen page repaints only when asked, so the frame is requested first. */
async function capturePng(win: BrowserWindow): Promise<string> {
  win.webContents.invalidate();
  return (await win.webContents.capturePage()).toPNG().toString('base64');
}

/**
 * A guest window with the page loaded and its first frame painted.
 */
async function openStage(html: string, width: number, height: number): Promise<BrowserWindow> {
  const win = createArtifactWindow(true, { offscreen: true });
  win.webContents.setBackgroundThrottling(false);
  win.setContentSize(width, height);
  try {
    const probed = html.replace(/<head[^>]*>/i, (open) => open + ERROR_PROBE);
    const page = probed.includes(ERROR_PROBE) ? probed : ERROR_PROBE + probed;
    // The previous stage's window clears the shared guest session as it closes, and a load that overlaps that clear is cancelled: retry after it.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await loadArtifactHtml(win, page, true);
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    await paint(win);
    return win;
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
}

/**
 * Puts the stage's page under prefers-reduced-motion and reloads it, so the
 * page's own media queries resolve the reduced way from its first frame. One
 * window does both passes: a second window would clear the shared guest
 * session while it loads.
 */
async function emulateReduced(win: BrowserWindow): Promise<void> {
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const loaded = new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
  win.webContents.reload();
  await loaded;
  await paint(win);
}

/**
 * The animations and transitions the page starts: listed right after load and
 * again after any hover or focus. Then the page is reloaded under reduced motion,
 * and whatever still runs a moment after it starts is reported.
 */
async function renderMotion(request: DesignRenderRequest, html: string, width: number, height: number): Promise<DesignRenderResult> {
  const win = await openStage(html, width, height);
  try {
    const error = await triggerState(win, request);
    if (error) return { ok: false, error, width, height, consoleErrors: [] };
    await paint(win);
    const animations = await win.webContents.executeJavaScript(ANIMATION_SCRIPT, false) as DesignAnimation[];
    await emulateReduced(win);
    const reducedError = await triggerState(win, request);
    if (reducedError) return { ok: false, error: reducedError, width, height, consoleErrors: [] };
    await paint(win);
    const running = (await win.webContents.executeJavaScript(ANIMATION_SCRIPT, false) as DesignAnimation[])
      .filter((animation) => animation.playState === 'running' || animation.playState === 'pending');
    return {
      ok: true,
      width,
      height,
      consoleErrors: [],
      animations,
      reducedRunning: running,
      outline: motionReport({ animations, reducedRunning: running, hovered: request.hover, focused: request.focus })
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Captures the page at evenly spaced instants. Each frame gets its own stage:
 * a hidden or offscreen page stops painting after its first capture, so the
 * second capture of one window never returns. In each stage the state is set
 * (hover, focus, scroll), every animation is paused and sought to the instant,
 * and only then is the frame painted and captured, so every frame is the same
 * moment on the timeline.
 */
async function renderFrames(request: DesignRenderRequest, html: string, width: number, height: number): Promise<DesignRenderResult> {
  const frames: DesignFrame[] = [];
  for (const t of frameTimes(request.frames, request.durationMs)) {
    const win = await openStage(html, width, height);
    try {
      const error = await triggerState(win, request);
      if (error) return { ok: false, error, width, height, consoleErrors: [] };
      await win.webContents.executeJavaScript(seekScript(t), false);
      await paint(win);
      const samples = await win.webContents.executeJavaScript(SAMPLE_SCRIPT, false) as DesignMotionSample[];
      // The first capture of a stage is the one that returns; the picture is only kept when a vision model reads it.
      const png = request.withImages ? await capturePng(win) : '';
      frames.push({ t, png, samples });
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
  return { ok: true, width, height, consoleErrors: [], frames, outline: frameOutline(frames) };
}

async function settle(win: BrowserWindow): Promise<{ height: number; errors: string[] }> {
  return win.webContents.executeJavaScript(SETTLE_SCRIPT, false);
}

export async function renderDesign(request: DesignRenderRequest): Promise<DesignRenderResult> {
  const width = clamp(request.width, 280, 2560, 1440);
  const height = clamp(request.height, 300, 2400, 900);
  if (typeof request.html !== 'string' || !request.html) return { ok: false, error: 'Nothing to render.', width, height, consoleErrors: [] };
  if (request.mode === 'frames' || request.mode === 'motion') {
    const flow = request.mode === 'frames' ? renderFrames : renderMotion;
    return withArtifactTimeout(flow(request, request.html, width, height), 60_000).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      width,
      height,
      consoleErrors: []
    }));
  }
  const win = createArtifactWindow(true);
  win.webContents.setBackgroundThrottling(false);
  try {
    return await withArtifactTimeout((async (): Promise<DesignRenderResult> => {
      win.setContentSize(width, height);
      const html = request.html.replace(/<head[^>]*>/i, (open) => open + ERROR_PROBE);
      await loadArtifactHtml(win, html.includes(ERROR_PROBE) ? html : ERROR_PROBE + html, true);
      let state = await settle(win);
      const stateError = await triggerState(win, request, true);
      if (stateError) return { ok: false, error: stateError, width, height, consoleErrors: state.errors };
      let shotHeight = height;
      if (request.mode === 'screenshot' && request.fullPage && state.height > height) {
        shotHeight = Math.min(MAX_FULL_PAGE, state.height);
        win.setContentSize(width, shotHeight);
        state = await settle(win);
      }
      const base = { ok: true, width, height: shotHeight, consoleErrors: state.errors };
      if (request.mode === 'screenshot') {
        let image = await win.webContents.capturePage();
        if (image.getSize().width > width) image = image.resize({ width });
        return { ...base, width: image.getSize().width, height: image.getSize().height, png: image.toPNG().toString('base64') };
      }
      if (request.mode === 'inspect') {
        const found = await win.webContents.executeJavaScript(inspectScript(String(request.selector || '')), false) as { error?: string; matches?: unknown[]; count?: number };
        if (found.error) return { ...base, ok: false, error: found.error };
        return { ...base, matches: found.matches ?? [], outline: `${found.count ?? 0} element(s) match.` };
      }
      const picture = await win.webContents.executeJavaScript(OUTLINE_SCRIPT, false) as { lines: string[]; truncated: boolean; scrollWidth: number; scrollHeight: number; viewport: number };
      const header = `Viewport ${picture.viewport}px wide, page ${picture.scrollWidth}x${picture.scrollHeight}${picture.scrollWidth > picture.viewport + 1 ? ' (HORIZONTAL OVERFLOW)' : ''}. Boxes are [x,y widthxheight].`;
      return { ...base, outline: [header, ...picture.lines, ...(picture.truncated ? ['…(outline truncated)'] : [])].join('\n') };
    })(), 30_000);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), width, height, consoleErrors: [] };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
