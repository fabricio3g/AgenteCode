/**
 * Source that runs inside the reference page, in its own window (`reference.ts`).
 * It is written as a string, not as a function serialized with `toString()`:
 * a function compiled from TypeScript can pick up helpers (such as `__name`)
 * that the page does not have. The script tallies what a design system is made
 * of and returns plain data; `reference-tokens.ts` ranks and merges it.
 */

/** The reader: an expression whose value is the capture. */
export const REFERENCE_PAGE_SCRIPT = String.raw`(function readReferencePage() {
  var MAX_ELEMENTS = 2500;
  var TYPE_ROLES = { H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6', P: 'p', SMALL: 'small', BUTTON: 'button' };
  var colors = new Map();
  var fonts = new Map();
  var types = new Map();
  var spacing = new Map();
  var radii = new Map();
  var shadows = new Map();
  var widths = new Map();
  var grids = new Map();
  var typeSamples = {};
  var colorCache = new Map();
  var ctx = null;
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    ctx = canvas.getContext ? canvas.getContext('2d', { willReadFrequently: true }) : null;
  } catch (error) {
    ctx = null;
  }

  function bump(map, key, by) { map.set(key, (map.get(key) || 0) + by); }
  function num(value) { var n = parseFloat(value); return isFinite(n) ? n : 0; }
  function hex2(n) { var s = Math.round(n).toString(16); return s.length < 2 ? '0' + s : s; }

  // Canvas reads every colour syntax the page can use (oklch, color(), hsl) and returns 8-bit sRGB.
  function toSrgb(value) {
    if (ctx) {
      try {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000000';
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        var px = ctx.getImageData(0, 0, 1, 1).data;
        return { r: px[0], g: px[1], b: px[2], a: px[3] / 255 };
      } catch (error) {
        // Fall through to the string reader.
      }
    }
    var fn = /rgba?\(([^)]+)\)/.exec(value);
    if (fn) {
      var parts = fn[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    var hex = /^#([0-9a-f]{6})$/i.exec(value);
    if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4, 6), 16), a: 1 };
    return null;
  }

  // A colour as the pure module reads it: #rrggbb, or rgba(...) when translucent; null when invisible.
  function colorKey(value) {
    if (!value) return null;
    if (colorCache.has(value)) return colorCache.get(value);
    var c = toSrgb(value);
    var key = null;
    if (c && c.a >= 0.05) {
      key = c.a >= 0.999
        ? '#' + hex2(c.r) + hex2(c.g) + hex2(c.b)
        : 'rgba(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ', ' + Math.round(c.a * 100) / 100 + ')';
    }
    colorCache.set(value, key);
    return key;
  }

  function firstFamily(value) { return String(value || '').split(',')[0].replace(/["']/g, '').trim() || 'sans-serif'; }
  function ownText(el) {
    var text = '';
    for (var node = el.firstChild; node; node = node.nextSibling) if (node.nodeType === 3) text += node.nodeValue;
    return text.replace(/\s+/g, ' ').trim();
  }

  var list = [document.documentElement];
  if (document.body) list.push(document.body);
  var all = document.querySelectorAll('body *');
  for (var k = 0; k < all.length && list.length < MAX_ELEMENTS; k++) list.push(all[k]);

  var sampled = 0;
  var sides = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap'];
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    sampled++;
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0 };
    var isRoot = el === document.documentElement || el === document.body;

    var text = ownText(el);
    if (text) {
      var textColor = colorKey(cs.color);
      if (textColor) bump(colors, 'text|' + textColor, 1);
      var family = firstFamily(cs.fontFamily);
      bump(fonts, (/^H[1-3]$/.test(el.tagName) ? 'heading' : 'text') + '|' + family, 1);
      var role = TYPE_ROLES[el.tagName];
      if (role && (typeSamples[role] || 0) < 40) {
        typeSamples[role] = (typeSamples[role] || 0) + 1;
        var lineHeight = cs.lineHeight === 'normal' ? 0 : Math.round(num(cs.lineHeight) * 10) / 10;
        bump(types, [role, Math.round(num(cs.fontSize) * 10) / 10, cs.fontWeight, lineHeight, family].join('|'), 1);
      }
    }

    var background = colorKey(cs.backgroundColor);
    if (background) bump(colors, 'background|' + background, isRoot ? 60 : 1);
    if (background && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || /(^|\s)(btn|button)(\s|$)/.test(el.getAttribute('class') || ''))) {
      bump(colors, 'button|' + background, 1);
    }
    if (num(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') {
      var border = colorKey(cs.borderTopColor);
      if (border) bump(colors, 'border|' + border, 1);
    }

    for (var s = 0; s < sides.length; s++) {
      var space = Math.round(num(cs[sides[s]]));
      if (space >= 1 && space <= 200) bump(spacing, space, 1);
    }
    if (cs.borderTopLeftRadius && cs.borderTopLeftRadius !== '0px') bump(radii, cs.borderTopLeftRadius, 1);
    if (cs.boxShadow && cs.boxShadow !== 'none') bump(shadows, cs.boxShadow.slice(0, 160), 1);

    if (cs.maxWidth && /px$/.test(cs.maxWidth) && rect.width > 0) {
      var maxWidth = Math.round(num(cs.maxWidth));
      if (maxWidth >= 480 && maxWidth <= 1920) bump(widths, maxWidth, 1);
    }
    if ((cs.display === 'grid' || cs.display === 'inline-grid') && cs.gridTemplateColumns && cs.gridTemplateColumns !== 'none') {
      var columns = cs.gridTemplateColumns.trim().split(/\s+/).length;
      if (columns >= 2 && columns <= 12) bump(grids, columns, 1);
    }
  }

  function top(map, limit, shape) {
    var rows = [];
    map.forEach(function (count, key) { rows.push({ key: key, count: count }); });
    rows.sort(function (a, b) { return b.count - a.count; });
    return rows.slice(0, limit).map(function (row) { return shape(row.key, row.count); });
  }

  return {
    url: location.href,
    title: document.title || '',
    width: window.innerWidth,
    height: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    sampled: sampled,
    colors: top(colors, 160, function (key, count) {
      var cut = key.indexOf('|');
      return { role: key.slice(0, cut), color: key.slice(cut + 1), count: count };
    }),
    fonts: top(fonts, 60, function (key, count) {
      var cut = key.indexOf('|');
      return { role: key.slice(0, cut), family: key.slice(cut + 1), count: count };
    }),
    types: top(types, 200, function (key, count) {
      var parts = key.split('|');
      return { role: parts[0], size: parseFloat(parts[1]), weight: parseInt(parts[2], 10) || 400, lineHeight: parseFloat(parts[3]) || 0, family: parts.slice(4).join('|'), count: count };
    }),
    spacing: top(spacing, 40, function (key, count) { return { value: Number(key), count: count }; }),
    radii: top(radii, 12, function (key, count) { return { value: key, count: count }; }),
    shadows: top(shadows, 8, function (key, count) { return { value: key, count: count }; }),
    maxWidths: top(widths, 12, function (key, count) { return { value: Number(key), count: count }; }),
    gridColumns: top(grids, 6, function (key, count) { return { value: Number(key), count: count }; }),
    sections: document.querySelectorAll('section').length,
    hasNav: !!document.querySelector('nav, [role="navigation"]'),
    hasFooter: !!document.querySelector('footer')
  };
})()`;

/** Run after load: wait for the web fonts and two frames of layout, but never more than 1.5 s. */
export const REFERENCE_SETTLE_SCRIPT = `Promise.race([
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () {
    return new Promise(function (done) { requestAnimationFrame(function () { requestAnimationFrame(done); }); });
  }),
  new Promise(function (done) { setTimeout(done, 1500); })
]).then(function () { return true; })`;
