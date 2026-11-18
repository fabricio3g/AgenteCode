/**
 * Pointing at a design. The canvas frame is an opaque origin, so the picker
 * lives inside it as a plain script and talks to the app only through
 * postMessage. This file holds that script, the parent-side reader for what
 * it sends, and the pure helpers that turn picks into agent context.
 */
import type { DesignComment, DesignPick, DesignSelection, DesignStroke } from '$shared/design';
import { formatMarks, PROBE_POINTS } from './design-strokes';

const FRAME_SOURCE = 'agente-design-frame';
export const HOST_SOURCE = 'agente-design';

/**
 * The in-frame script. Plain ES5 on purpose: it runs in whatever page the agent
 * wrote. No backticks or template interpolation in here, and no backslashes, so
 * the TypeScript string carries it through unchanged.
 */
export const PICKER_SOURCE = `(function () {
  if (window.__agenteDesignPicker) return;
  window.__agenteDesignPicker = true;
  var FRAME = 'agente-design-frame';
  var HOST = 'agente-design';
  var STYLE_KEYS = ['color', 'background-color', 'font-size', 'font-weight', 'font-family', 'padding', 'margin', 'border-radius', 'gap', 'display'];
  var root = document.documentElement;
  var mode = 'browse';
  var hoverEl = null;
  var editing = null;
  var editRaw = '';
  var editOld = '';
  var highlights = [];

  var host = document.createElement('div');
  host.setAttribute('data-agente-picker', '');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  root.appendChild(host);
  var shadow = host.attachShadow({ mode: 'closed' });
  var style = document.createElement('style');
  // The outline is drawn outside the element's box, so it never sits on the text it marks.
  style.textContent = '.box{position:fixed;left:0;top:0;display:none;box-sizing:border-box;pointer-events:none;outline:1.5px solid #e76d1f;outline-offset:2px;border-radius:3px}' +
    '.target{position:fixed;left:0;top:0;display:none;box-sizing:border-box;pointer-events:none;outline:2px dashed #e76d1f;outline-offset:3px;border-radius:3px}' +
    '.tag{position:absolute;left:-3.5px;top:-24px;padding:2px 6px;border-radius:4px;background:#e76d1f;color:#fff;font:500 11px/1.4 system-ui,sans-serif;white-space:nowrap}';
  shadow.appendChild(style);
  var hoverBox = document.createElement('div');
  hoverBox.className = 'box';
  var hoverTag = document.createElement('span');
  hoverTag.className = 'tag';
  hoverBox.appendChild(hoverTag);
  shadow.appendChild(hoverBox);
  var selBoxes = [];
  var cursorStyle = document.createElement('style');
  (document.head || root).appendChild(cursorStyle);

  function post(message) {
    message.source = FRAME;
    window.parent.postMessage(message, '*');
  }

  function clean(text) {
    return String(text || '').replace(/\\s+/g, ' ').trim();
  }

  function ident(value) {
    return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : '';
  }

  function classList(el) {
    var names = (el.getAttribute('class') || '').split(/\\s+/);
    var out = [];
    for (var i = 0; i < names.length && out.length < 2; i++) {
      if (ident(names[i])) out.push(names[i]);
    }
    return out;
  }

  function countMatches(selector) {
    try { return document.querySelectorAll(selector).length; } catch (e) { return 0; }
  }

  function selectorFor(el) {
    if (el.id && ident(el.id) && countMatches('#' + el.id) === 1) return '#' + el.id;
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var seg = node.tagName.toLowerCase();
      var classes = classList(node);
      for (var i = 0; i < classes.length; i++) seg += '.' + classes[i];
      var parent = node.parentElement;
      if (parent) {
        var same = 0;
        var index = 0;
        for (var child = parent.firstElementChild; child; child = child.nextElementSibling) {
          if (child.tagName === node.tagName) {
            same += 1;
            if (child === node) index = same;
          }
        }
        if (same > 1) seg += ':nth-of-type(' + index + ')';
      }
      parts.unshift(seg);
      if (node === document.body || node === root) break;
      node = parent;
    }
    for (var start = parts.length - 1; start >= 0; start--) {
      var candidate = parts.slice(start).join(' > ');
      var matches = document.querySelectorAll(candidate);
      if (matches.length === 1 && matches[0] === el) return candidate;
    }
    return parts.join(' > ');
  }

  function shortName(el) {
    var classes = classList(el);
    return el.tagName.toLowerCase() + (classes.length ? '.' + classes[0] : '');
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var computed = window.getComputedStyle(el);
    var styles = {};
    for (var i = 0; i < STYLE_KEYS.length; i++) {
      var value = computed.getPropertyValue(STYLE_KEYS[i]);
      if (value) styles[STYLE_KEYS[i]] = value;
    }
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: clean(el.textContent).slice(0, 140),
      html: String(el.outerHTML || '').slice(0, 1500),
      box: {
        x: Math.round(rect.left + window.pageXOffset),
        y: Math.round(rect.top + window.pageYOffset),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      styles: styles
    };
  }

  function place(node, el) {
    var rect = el.getBoundingClientRect();
    node.style.display = 'block';
    node.style.left = rect.left + 'px';
    node.style.top = rect.top + 'px';
    node.style.width = rect.width + 'px';
    node.style.height = rect.height + 'px';
  }

  function hide(node) {
    node.style.display = 'none';
  }

  function layout() {
    if (targetId) setTarget(targetId);
    if (hoverEl && mode === 'select' && hoverEl !== editing) {
      place(hoverBox, hoverEl);
      hoverTag.textContent = shortName(hoverEl) + ' ' + Math.round(hoverEl.getBoundingClientRect().width) + '\\u00d7' + Math.round(hoverEl.getBoundingClientRect().height);
    } else {
      hide(hoverBox);
    }
    var targets = [];
    for (var i = 0; i < highlights.length; i++) {
      var found = null;
      try { found = document.querySelector(highlights[i]); } catch (e) { found = null; }
      if (found) targets.push(found);
    }
    while (selBoxes.length < targets.length) {
      var box = document.createElement('div');
      box.className = 'box';
      shadow.appendChild(box);
      selBoxes.push(box);
    }
    for (var j = 0; j < selBoxes.length; j++) {
      if (j < targets.length) place(selBoxes[j], targets[j]); else hide(selBoxes[j]);
    }
  }

  function setHighlights(list) {
    highlights = [];
    if (Object.prototype.toString.call(list) === '[object Array]') {
      for (var i = 0; i < list.length; i++) {
        if (typeof list[i] === 'string') highlights.push(list[i]);
      }
    }
    layout();
  }

  function finishEdit(commit) {
    var el = editing;
    if (!el) return;
    editing = null;
    el.removeEventListener('blur', onEditBlur);
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
    var next = clean(el.textContent);
    if (!commit) {
      el.textContent = editRaw;
    } else if (next !== editOld) {
      var rect = el.getBoundingClientRect();
      post({
        type: 'textEdit',
        selector: selectorFor(el),
        oldText: editOld,
        newText: next,
        x: Math.round(rect.left + window.pageXOffset),
        y: Math.round(rect.top + window.pageYOffset)
      });
    }
    layout();
  }

  function onEditBlur() {
    finishEdit(true);
  }

  function startEdit(el) {
    editing = el;
    editRaw = el.textContent;
    editOld = clean(editRaw);
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.addEventListener('blur', onEditBlur);
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    layout();
  }

  function isLeafText(el) {
    return el && el.nodeType === 1 && el.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      el.children.length === 0 && clean(el.textContent).length > 0 && !el.isContentEditable;
  }

  function setMode(next, cursor) {
    if (next !== 'select' && next !== 'comment') next = 'browse';
    if (editing && next !== mode) finishEdit(true);
    mode = next;
    hoverEl = null;
    // The host sends the tool's pointer (design-cursors.ts); crosshair if it sends none.
    var pointer = typeof cursor === 'string' && cursor.indexOf(';') < 0 && cursor.indexOf('}') < 0 ? cursor : 'crosshair';
    cursorStyle.textContent = mode === 'browse' ? '' : 'html, html * { cursor: ' + pointer + ' !important; }';
    layout();
  }

  var targetBox = document.createElement('div');
  targetBox.className = 'target';
  shadow.appendChild(targetBox);
  var targetId = '';
  var watchTimer = null;
  var lastCount = -1;
  var lastTick = '';
  var armed = false;
  var reducedStyle = null;
  var restored = [];

  function liveAnimations() {
    return document.getAnimations ? document.getAnimations() : [];
  }

  function kindOf(anim) {
    if (typeof CSSTransition !== 'undefined' && anim instanceof CSSTransition) return 'transition';
    if (typeof CSSAnimation !== 'undefined' && anim instanceof CSSAnimation) return 'animation';
    return 'script';
  }

  function keyframeNames(anim) {
    var names = [];
    try {
      var frames = anim.effect.getKeyframes();
      for (var i = 0; i < frames.length; i++) {
        for (var key in frames[i]) {
          if (key !== 'offset' && key !== 'computedOffset' && key !== 'easing' && key !== 'composite' && names.indexOf(key) < 0 && names.length < 6) names.push(key);
        }
      }
    } catch (e) { /* nothing to read */ }
    return names;
  }

  /** Every live animation as the host lists it. An id is its index in the live list, so 'focus' and 'pick' find it again. */
  function animationItems() {
    var list = liveAnimations(), items = [];
    for (var i = 0; i < list.length && items.length < 40; i++) {
      var anim = list[i], fx = anim.effect;
      if (!fx) continue;
      var timing = fx.getComputedTiming(), kind = kindOf(anim), target = fx.target;
      var props = kind === 'transition' && anim.transitionProperty ? [String(anim.transitionProperty)] : keyframeNames(anim);
      var name = kind === 'animation' ? String(anim.animationName || '') : kind === 'transition' ? String(anim.transitionProperty || '') : '';
      items.push({
        id: 'a' + i,
        selector: target ? selectorFor(target) : '',
        tag: target ? target.tagName.toLowerCase() : '',
        name: name.slice(0, 60),
        kind: kind,
        properties: props,
        delay: Math.round(Number(timing.delay) || 0),
        duration: Math.round(Number(timing.duration) || 0),
        iterations: timing.iterations === Infinity ? 'infinite' : (Number(timing.iterations) || 1),
        easing: String(timing.easing || 'linear').slice(0, 80),
        playState: String(anim.playState || '')
      });
    }
    return items;
  }

  function postList() {
    lastCount = liveAnimations().length;
    post({ type: 'animations', items: animationItems(), reduced: reducedStyle !== null });
  }

  function forEachAnimation(fn) {
    var list = liveAnimations();
    for (var i = 0; i < list.length; i++) fn(list[i]);
  }

  /**
   * Makes every CSS animation live: a finished one is no longer in the list, so
   * each animated element is restarted (animation none, then its own value back)
   * and every animation is held at its start, ready to be sought.
   */
  function arm() {
    var els = document.querySelectorAll('*');
    restored = [];
    for (var i = 0; i < els.length; i++) {
      var cs = window.getComputedStyle(els[i]);
      if (cs.animationName && cs.animationName !== 'none') {
        restored.push({ el: els[i], value: els[i].style.animation });
        els[i].style.animation = 'none';
      }
    }
    void document.documentElement.offsetWidth;
    for (var j = 0; j < restored.length; j++) restored[j].el.style.animation = restored[j].value;
    forEachAnimation(function (a) { a.pause(); a.currentTime = 0; });
    armed = true;
  }

  function setRate(rate) {
    forEachAnimation(function (a) { a.playbackRate = rate; });
  }

  /** The preview's reduced motion: durations cut to a hundredth of a millisecond, the way a reduce block would leave them. */
  function setReduced(on) {
    if (on && !reducedStyle) {
      reducedStyle = document.createElement('style');
      reducedStyle.setAttribute('data-agente-reduced', '');
      reducedStyle.textContent = '*,*::before,*::after{animation-duration:.01ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:.01ms!important;transition-delay:0s!important}';
      (document.head || root).appendChild(reducedStyle);
    } else if (!on && reducedStyle) {
      if (reducedStyle.parentNode) reducedStyle.parentNode.removeChild(reducedStyle);
      reducedStyle = null;
    }
  }

  function setWatch(on) {
    if (on && watchTimer === null) watchTimer = setInterval(tick, 100);
    if (!on && watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  /** The playhead, sent while the timeline watches: the furthest animation's time, and whether anything runs. */
  function tick() {
    var list = liveAnimations(), time = 0, playing = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].playState === 'running') playing = true;
      var at = Number(list[i].currentTime) || 0;
      if (at > time) time = at;
    }
    var key = Math.round(time) + ':' + playing + ':' + list.length;
    if (key !== lastTick) {
      lastTick = key;
      post({ type: 'animTick', time: Math.round(time), playing: playing, count: list.length });
    }
    if (list.length !== lastCount) postList();
  }

  function release() {
    setWatch(false);
    setRate(1);
    forEachAnimation(function (a) { a.play(); });
    setReduced(false);
    armed = false;
  }

  function targetOf(id) {
    var index = Number(String(id || '').replace(/^a/, ''));
    var list = liveAnimations();
    var fx = list[index] && list[index].effect;
    return fx && fx.target ? fx.target : null;
  }

  function setTarget(id) {
    targetId = id || '';
    var el = targetId ? targetOf(targetId) : null;
    if (el) place(targetBox, el);
    else hide(targetBox);
  }

  function animCommand(data) {
    var action = data.action;
    if (action === 'open') {
      arm();
      postList();
      setWatch(true);
    } else if (action === 'close') {
      setTarget('');
      release();
      postList();
    } else if (action === 'list') {
      postList();
    } else if (action === 'play') {
      if (!armed) arm();
      forEachAnimation(function (a) { a.play(); });
    } else if (action === 'pause') {
      forEachAnimation(function (a) { a.pause(); });
    } else if (action === 'seek') {
      if (!armed) arm();
      var ms = isFinite(data.ms) ? Math.max(0, data.ms) : 0;
      forEachAnimation(function (a) { a.pause(); a.currentTime = ms; });
    } else if (action === 'rate') {
      setRate(isFinite(data.rate) && data.rate > 0 ? data.rate : 1);
    } else if (action === 'replay') {
      arm();
      forEachAnimation(function (a) { a.currentTime = 0; a.play(); });
    } else if (action === 'reduced') {
      // A reduced page shows its end state at once, so the preview jumps there; switching back rewinds to the start.
      setReduced(data.on === true);
      forEachAnimation(function (a) {
        a.pause();
        if (data.on === true) {
          try { a.finish(); } catch (e) { /* an endless animation has no end to jump to */ }
        } else {
          a.currentTime = 0;
        }
      });
      postList();
    } else if (action === 'focus') {
      setTarget(typeof data.id === 'string' ? data.id : '');
    } else if (action === 'pick') {
      var el = targetOf(data.id);
      if (el) post({ type: 'select', element: describe(el), additive: true });
    }
  }

  /** Selects an element by selector (the Layers panel); reveal scrolls it into view first. */
  function pickBySelector(selector, reveal) {
    if (typeof selector !== 'string' || selector.length > 300) return;
    var el = null;
    try { el = document.querySelector(selector); } catch (e) { el = null; }
    if (!el || el.nodeType !== 1) return;
    if (reveal === true && el.scrollIntoView) {
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch (e2) { el.scrollIntoView(); }
    }
    post({ type: 'select', element: describe(el), additive: false });
    layout();
  }

  /** What sits under each point (viewport px): drawn marks are described by the elements they cross. */
  function probe(id, points) {
    if (typeof id !== 'string' || Object.prototype.toString.call(points) !== '[object Array]') return;
    var hits = [];
    for (var i = 0; i < points.length && i < 16; i++) {
      var p = points[i];
      var list = [];
      if (p && isFinite(p.x) && isFinite(p.y)) {
        var found = document.elementFromPoint(p.x, p.y);
        if (found && found.nodeType === 1) list.push(selectorFor(found));
      }
      hits.push(list);
    }
    post({ type: 'probe', id: id, hits: hits });
  }

  /** Live preview of a design token: the custom property is set on the root until the page reloads with the saved value. */
  function setVar(name, value) {
    if (typeof name !== 'string' || !/^--[A-Za-z0-9_-]+$/.test(name)) return;
    if (value === null) root.style.removeProperty(name);
    else if (typeof value === 'string' && value.length < 200 && !/[;{}<>]/.test(value)) root.style.setProperty(name, value);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== HOST) return;
    if (data.type === 'tool') setMode(data.tool, data.cursor);
    else if (data.type === 'highlight') setHighlights(data.selectors);
    else if (data.type === 'anim') animCommand(data);
    else if (data.type === 'pick') pickBySelector(data.selector, data.reveal);
    else if (data.type === 'probe') probe(data.id, data.points);
    else if (data.type === 'cssvar') setVar(data.name, data.value);
    else if (data.type === 'scrollTo') window.scrollTo(isFinite(data.x) ? data.x : 0, isFinite(data.y) ? data.y : 0);
    else if (data.type === 'clear') {
      finishEdit(false);
      setHighlights([]);
    }
  });

  window.addEventListener('mousedown', function (event) {
    if (mode === 'browse') return;
    if (editing && editing.contains(event.target)) return;
    event.preventDefault();
  }, true);

  window.addEventListener('mousemove', function (event) {
    if (mode !== 'select' || editing) return;
    var el = event.target;
    if (!el || el.nodeType !== 1 || el === hoverEl) return;
    hoverEl = el;
    layout();
    post({ type: 'hover', selector: selectorFor(el), tag: el.tagName.toLowerCase() });
  }, true);

  window.addEventListener('click', function (event) {
    if (mode === 'browse') return;
    if (editing && editing.contains(event.target)) return;
    if (editing) finishEdit(true);
    event.preventDefault();
    event.stopPropagation();
    var el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (mode === 'select') {
      post({ type: 'select', element: describe(el), additive: !!event.shiftKey });
    } else {
      // The pin belongs to the element, so it anchors at the element's top-left corner, not at the click.
      var corner = el.getBoundingClientRect();
      post({ type: 'comment', selector: selectorFor(el), x: Math.round(corner.left + window.pageXOffset), y: Math.round(corner.top + window.pageYOffset) });
    }
  }, true);

  window.addEventListener('dblclick', function (event) {
    if (mode !== 'select' || editing) return;
    var el = event.target;
    if (!isLeafText(el)) return;
    event.preventDefault();
    event.stopPropagation();
    startEdit(el);
  }, true);

  window.addEventListener('keydown', function (event) {
    if (editing) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finishEdit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finishEdit(false);
      }
      return;
    }
    if (event.key === 'Escape' && mode !== 'browse') {
      setMode('browse');
      post({ type: 'escape' });
    }
  }, true);

  window.addEventListener('wheel', function (event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    post({ type: 'wheel', deltaY: event.deltaY, x: Math.round(event.clientX), y: Math.round(event.clientY) });
  }, { capture: true, passive: false });

  function onScroll(event) {
    layout();
    var target = event.target;
    if (target === document || target === root || target === document.body) {
      post({ type: 'scroll', x: Math.round(window.pageXOffset), y: Math.round(window.pageYOffset) });
    }
  }
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', layout);
})();`;

/** The script as a `<script>` element, ready to sit in a document. */
export const PICKER_SCRIPT = `<script>${PICKER_SOURCE}</script>`;

/** Injects the picker before the last `</body>` (or appends it when there is none). */
export function withPicker(html: string): string {
  const closers = [...html.matchAll(/<\/body\s*>/gi)];
  const last = closers[closers.length - 1];
  if (!last || last.index === undefined) return html + PICKER_SCRIPT;
  return html.slice(0, last.index) + PICKER_SCRIPT + html.slice(last.index);
}

/** One live animation on the canvas page, as the picker lists it. `id` is what the timeline sends back to find it. */
export interface MotionItem {
  id: string;
  selector: string;
  tag: string;
  name: string;
  kind: 'transition' | 'animation' | 'script';
  properties: string[];
  /** ms */
  delay: number;
  /** ms, of one pass */
  duration: number;
  iterations: number | 'infinite';
  easing: string;
  playState: string;
}

/** What the timeline asks the page to do. Every command goes to the frame over postMessage, validated on its side. */
export type AnimCommand =
  | { action: 'open' | 'close' | 'list' | 'play' | 'pause' | 'replay' }
  | { action: 'seek'; ms: number }
  | { action: 'rate'; rate: number }
  | { action: 'reduced'; on: boolean }
  | { action: 'focus' | 'pick'; id: string };

export type FrameMessage =
  | { type: 'select'; element: DesignPick; additive: boolean }
  | { type: 'comment'; selector: string; x: number; y: number }
  | { type: 'textEdit'; selector: string; oldText: string; newText: string; x: number; y: number }
  | { type: 'hover'; selector: string; tag: string }
  | { type: 'escape' }
  | { type: 'scroll'; x: number; y: number }
  /** Ctrl/⌘+wheel inside the page; x/y are the pointer in the frame's own px, when it sent them. */
  | { type: 'wheel'; deltaY: number; x?: number; y?: number }
  /** What sat under each point of a `probe`: selectors per point, in the order sent. */
  | { type: 'probe'; id: string; hits: string[][] }
  | { type: 'animations'; items: MotionItem[]; reduced: boolean }
  | { type: 'animTick'; time: number; playing: boolean; count: number };

/** A frame's animation list is capped, the same as the picker's own list. */
const MOTION_LIMIT = 40;
const ANIMATION_KINDS = ['transition', 'animation', 'script'];

const isStr = (value: unknown): value is string => typeof value === 'string';
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function readMotionItem(value: unknown): MotionItem | null {
  if (!isRecord(value) || !isStr(value.id) || !isStr(value.selector) || !isStr(value.tag) || !isStr(value.name) || !isStr(value.easing) || !isStr(value.playState)) return null;
  if (!isStr(value.kind) || !ANIMATION_KINDS.includes(value.kind)) return null;
  if (!Array.isArray(value.properties) || !value.properties.every(isStr)) return null;
  if (!isNum(value.delay) || !isNum(value.duration)) return null;
  const iterations = value.iterations === 'infinite' ? 'infinite' : isNum(value.iterations) ? value.iterations : null;
  if (iterations === null) return null;
  return {
    id: value.id.slice(0, 20),
    selector: value.selector.slice(0, 300),
    tag: value.tag.slice(0, 40),
    name: value.name.slice(0, 60),
    kind: value.kind as MotionItem['kind'],
    properties: value.properties.slice(0, 6).map((prop) => String(prop).slice(0, 40)),
    delay: value.delay,
    duration: value.duration,
    iterations,
    easing: value.easing.slice(0, 80),
    playState: value.playState.slice(0, 20)
  };
}

function readPick(value: unknown): DesignPick | null {
  if (!isRecord(value) || !isStr(value.selector) || !isStr(value.tag) || !isStr(value.text) || !isStr(value.html)) return null;
  const box = value.box;
  if (!isRecord(box) || !isNum(box.x) || !isNum(box.y) || !isNum(box.width) || !isNum(box.height)) return null;
  const styles: Record<string, string> = {};
  if (isRecord(value.styles)) {
    for (const [key, item] of Object.entries(value.styles)) if (isStr(item)) styles[key] = item.slice(0, 200);
  }
  return {
    selector: value.selector.slice(0, 300),
    tag: value.tag.slice(0, 40),
    text: value.text.slice(0, 140),
    html: value.html.slice(0, 1500),
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    styles
  };
}

/** Validates what the frame posted. Anything malformed is dropped (null). */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (!isRecord(data) || data.source !== FRAME_SOURCE) return null;
  switch (data.type) {
    case 'select': {
      const element = readPick(data.element);
      return element ? { type: 'select', element, additive: data.additive === true } : null;
    }
    case 'comment':
      return isStr(data.selector) && isNum(data.x) && isNum(data.y)
        ? { type: 'comment', selector: data.selector.slice(0, 300), x: data.x, y: data.y }
        : null;
    case 'textEdit':
      return isStr(data.selector) && isStr(data.oldText) && isStr(data.newText) && isNum(data.x) && isNum(data.y)
        ? { type: 'textEdit', selector: data.selector.slice(0, 300), oldText: data.oldText, newText: data.newText, x: data.x, y: data.y }
        : null;
    case 'hover':
      return isStr(data.selector) && isStr(data.tag) ? { type: 'hover', selector: data.selector, tag: data.tag } : null;
    case 'escape':
      return { type: 'escape' };
    case 'scroll':
      return isNum(data.x) && isNum(data.y) ? { type: 'scroll', x: data.x, y: data.y } : null;
    case 'wheel':
      return isNum(data.deltaY) ? { type: 'wheel', deltaY: data.deltaY, ...(isNum(data.x) && isNum(data.y) ? { x: data.x, y: data.y } : {}) } : null;
    case 'probe': {
      if (!isStr(data.id) || !Array.isArray(data.hits) || data.hits.length > PROBE_POINTS) return null;
      const hits = data.hits.map((point) => (Array.isArray(point) ? point.filter(isStr).slice(0, 3).map((selector) => selector.slice(0, 300)) : []));
      return { type: 'probe', id: data.id.slice(0, 60), hits };
    }
    case 'animations': {
      if (!Array.isArray(data.items) || data.items.length > MOTION_LIMIT) return null;
      const items = data.items.map(readMotionItem);
      return items.every((item): item is MotionItem => item !== null) ? { type: 'animations', items, reduced: data.reduced === true } : null;
    }
    case 'animTick':
      return isNum(data.time) && typeof data.playing === 'boolean' && isNum(data.count)
        ? { type: 'animTick', time: Math.max(0, data.time), playing: data.playing, count: Math.max(0, data.count) }
        : null;
    default:
      return null;
  }
}

/** The label a selection chip shows: `button.primary "Get started"`. */
export function pickLabel(pick: Pick<DesignPick, 'tag' | 'html' | 'text'>): string {
  const start = /^<[a-zA-Z][a-zA-Z0-9-]*([^>]*)>/.exec(pick.html);
  const cls = start ? /\sclass="([^"]*)"/.exec(start[1]) : null;
  const first = cls ? cls[1].trim().split(/\s+/)[0] : '';
  const name = pick.tag + (first && /^[A-Za-z_][\w-]*$/.test(first) ? `.${first}` : '');
  const text = pick.text.length > 24 ? `${pick.text.slice(0, 23)}…` : pick.text;
  return text ? `${name} "${text}"` : name;
}

/** The three outcomes for an edit the user made on the canvas. */
export interface TextEditDecision {
  kind: 'apply' | 'comment' | 'none';
  oldText: string;
  newText: string;
  /** What the agent is asked to do when the edit cannot be applied directly. */
  note: string;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * A text edit is applied straight to the source only when the old text is
 * found exactly once there; otherwise it becomes a comment for the agent,
 * because a guess at the right occurrence would change the wrong element.
 */
export function decideTextEdit(source: string | undefined, oldText: string, newText: string): TextEditDecision {
  const from = oldText.trim();
  const to = newText.trim();
  const note = `Change the text "${from}" to "${to}"`;
  if (from === to) return { kind: 'none', oldText: from, newText: to, note };
  if (source !== undefined && from.length > 0 && occurrences(source, from) === 1) {
    return { kind: 'apply', oldText: from, newText: to, note };
  }
  return { kind: 'comment', oldText: from, newText: to, note };
}

const fenceFor = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
};

/**
 * The markdown block a turn carries: what the user pointed at and what they
 * pinned. Empty when there is neither.
 */
export function formatTurnContext(selection: DesignSelection[], comments: DesignComment[], strokes: DesignStroke[] = []): string {
  if (!selection.length && !comments.length && !strokes.length) return '';
  const lines = [
    'The user selected the canvas elements, pinned the comments and drew the marks below. Change only what they name, unless the request asks for more. Edit each element surgically with design_edit (copy old_text exactly from design_read), and keep everything else unchanged.'
  ];
  const pages = [...new Set(selection.map((pick) => pick.page))];
  for (const page of pages) {
    lines.push('', `## The user pointed at these elements on ${page}`);
    selection.filter((pick) => pick.page === page).forEach((pick, index) => {
      const fence = fenceFor(pick.html);
      const box = pick.box;
      lines.push(
        '',
        `${index + 1}. \`${pick.selector}\` (${pick.tag}), ${Math.round(box.width)}×${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}${pick.width ? ` in the ${pick.width}px frame` : ''}`
      );
      if (pick.text) lines.push(`Text: "${pick.text}"`);
      lines.push(`${fence}html`, pick.html, fence);
      const styles = Object.entries(pick.styles).map(([key, value]) => `${key}: ${value}`);
      if (styles.length) lines.push(`Styles: ${styles.join('; ')}`);
    });
  }
  if (comments.length) {
    lines.push('', '## Comments pinned on the canvas');
    comments.forEach((comment, index) => {
      lines.push(`${index + 1}. ${comment.page}${comment.width ? ` at ${comment.width}px` : ''}, near \`${comment.selector}\`: ${comment.note}`);
    });
  }
  if (strokes.length) lines.push(...formatMarks(strokes));
  return lines.join('\n');
}
