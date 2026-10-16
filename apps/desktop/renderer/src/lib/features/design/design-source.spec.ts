import { describe, expect, it } from 'vitest';
import { findBySelector, mergeStyle, parseStyle, planStyleEdit, readAttributes, scanElements, styleEditNote, uniqueSpan } from './design-source';

const PAGE = `<!doctype html>
<html>
<head><title>x</title><style>.a > b { color: red }</style></head>
<body>
  <!-- <div class="ghost"></div> -->
  <header class="top"><h1 id="title">Hello</h1></header>
  <main class="wrap">
    <ul class="list">
      <li>One
      <li class="hot">Two</li>
      <li>Three</li>
    </ul>
    <button class="btn primary" style="color: red; padding: 4px">Go</button>
    <button class="btn">Stop</button>
    <img src="a.png" alt="a > b">
    <p>Intro <b>bold</b>
    <div class="card"><span>A</span></div>
  </main>
  <script>var s = "<div class='nope'></div>";</script>
</body>
</html>`;

describe('scanElements', () => {
  const els = scanElements(PAGE);
  const tags = els.map((el) => el.tag);

  it('finds elements in order and skips comments and raw text', () => {
    expect(tags.slice(0, 5)).toEqual(['html', 'head', 'title', 'style', 'body']);
    expect(tags.filter((tag) => tag === 'div')).toHaveLength(1);
    expect(els.some((el) => el.classes.includes('ghost') || el.classes.includes('nope'))).toBe(false);
  });

  it('closes optional end tags: li siblings, p before a block', () => {
    const list = els.find((el) => el.classes.includes('list'))!;
    expect(list.children.map((i) => els[i].tag)).toEqual(['li', 'li', 'li']);
    const p = els.find((el) => el.tag === 'p')!;
    const div = els.find((el) => el.tag === 'div')!;
    expect(div.parent).toBe(p.parent);
  });

  it('keeps a > inside a quoted attribute out of the tag end', () => {
    const img = els.find((el) => el.tag === 'img')!;
    expect(PAGE.slice(img.start, img.openEnd)).toBe('<img src="a.png" alt="a > b">');
  });
});

describe('readAttributes', () => {
  it('reads quoted, single-quoted and bare values with their positions', () => {
    const tag = `<a href="x" data-k='y' hidden title=z>`;
    const attrs = readAttributes(tag);
    expect(attrs.map((a) => [a.name, a.value])).toEqual([['href', 'x'], ['data-k', 'y'], ['hidden', ''], ['title', 'z']]);
    expect(tag.slice(attrs[0].start, attrs[0].end)).toBe('href="x"');
  });
});

describe('findBySelector', () => {
  const els = scanElements(PAGE);
  it('matches ids, class paths and nth-of-type like the picker writes them', () => {
    expect(findBySelector(els, '#title').map((el) => el.tag)).toEqual(['h1']);
    expect(findBySelector(els, 'ul.list > li:nth-of-type(2)').map((el) => el.classes)).toEqual([['hot']]);
    expect(findBySelector(els, 'main.wrap > button.btn:nth-of-type(2)')).toHaveLength(1);
    expect(findBySelector(els, 'button.btn')).toHaveLength(2);
    expect(findBySelector(els, 'html > body > main.wrap > div.card > span')).toHaveLength(1);
  });
  it('rejects selectors it cannot read', () => {
    expect(findBySelector(els, 'div p')).toEqual([]);
    expect(findBySelector(els, 'a[href]')).toEqual([]);
    expect(findBySelector(els, '')).toEqual([]);
  });
});

describe('style helpers', () => {
  it('parses declarations around parentheses and quotes', () => {
    expect(parseStyle(`color: red; background: url("a;b.png"); width: calc(1px + 2px)`)).toEqual([
      ['color', 'red'], ['background', 'url("a;b.png")'], ['width', 'calc(1px + 2px)']
    ]);
  });
  it('sets, replaces and removes', () => {
    expect(mergeStyle('color: red; padding: 4px', { color: 'blue', margin: '0' })).toBe('color: blue; padding: 4px; margin: 0');
    expect(mergeStyle('color: red', { color: null })).toBe('');
  });
});

describe('uniqueSpan', () => {
  it('widens by whole lines until the text occurs once', () => {
    const src = '<p>\n<b>a</b>\n</p>\n<p>\n<b>a</b>\n</p>\n<i>';
    const first = src.indexOf('<b>');
    const span = uniqueSpan(src, first, first + 3)!;
    expect(src.split(src.slice(span[0], span[1])).length - 1).toBe(1);
    expect(span[1] - span[0]).toBeGreaterThan(3);
  });
  it('returns the text itself when it is already unique', () => {
    expect(uniqueSpan('abc <x> def', 4, 7)).toEqual([4, 7]);
  });
});

describe('planStyleEdit', () => {
  const apply = (source: string, oldText: string, newText: string) => {
    expect(source.split(oldText).length - 1).toBe(1);
    return source.replace(oldText, newText);
  };

  it('adds a style attribute to an element without one', () => {
    const plan = planStyleEdit(PAGE, '#title', { 'font-size': '32px' });
    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') return;
    expect(apply(PAGE, plan.oldText, plan.newText)).toContain('<h1 id="title" style="font-size: 32px">Hello</h1>');
  });

  it('merges into an existing style attribute and keeps the rest', () => {
    const plan = planStyleEdit(PAGE, 'main.wrap > button.btn.primary', { color: 'var(--accent)', 'border-radius': '8px' });
    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') return;
    expect(apply(PAGE, plan.oldText, plan.newText)).toContain('<button class="btn primary" style="color: var(--accent); padding: 4px; border-radius: 8px">Go</button>');
  });

  it('removes the attribute when the last property goes', () => {
    const src = '<body><i class="x" style="color: red">a</i></body>';
    const plan = planStyleEdit(src, 'i.x', { color: null });
    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') return;
    expect(apply(src, plan.oldText, plan.newText)).toBe('<body><i class="x">a</i></body>');
  });

  it('inserts before the slash of a self-closing tag', () => {
    const src = '<body><img class="p" src="a.png" /></body>';
    const plan = planStyleEdit(src, 'img.p', { 'border-radius': '8px' });
    if (plan.kind !== 'apply') throw new Error('expected apply');
    expect(apply(src, plan.oldText, plan.newText)).toBe('<body><img class="p" src="a.png" style="border-radius: 8px" /></body>');
  });

  it('widens old_text when an identical tag appears twice', () => {
    const src = '<body>\n<div class="a">\n<i>one</i>\n</div>\n<div class="a">\n<i>two</i>\n</div>\n</body>';
    const plan = planStyleEdit(src, 'div.a:nth-of-type(2)', { color: 'red' });
    if (plan.kind !== 'apply') throw new Error('expected apply');
    expect(plan.oldText.length).toBeGreaterThan('<div class="a">'.length);
    const next = apply(src, plan.oldText, plan.newText);
    expect(next.indexOf('style="color: red"')).toBeGreaterThan(next.indexOf('one'));
  });

  it('falls back to a comment when the element is not found exactly once', () => {
    expect(planStyleEdit(PAGE, 'button.btn', { color: 'red' }).kind).toBe('comment');
    expect(planStyleEdit(PAGE, 'section.missing', { color: 'red' }).kind).toBe('comment');
    expect(planStyleEdit(undefined, '#title', { color: 'red' }).kind).toBe('comment');
  });

  it('refuses values that could break out of the attribute', () => {
    expect(planStyleEdit(PAGE, '#title', { color: 'red" onclick="x' }).kind).toBe('comment');
    expect(planStyleEdit(PAGE, '#title', { color: 'red; x: y' }).kind).toBe('comment');
    expect(planStyleEdit(PAGE, '#title', { 'Color!': 'red' }).kind).toBe('comment');
  });

  it('does nothing when nothing changes', () => {
    expect(planStyleEdit(PAGE, '#title', {}).kind).toBe('none');
    expect(planStyleEdit(PAGE, '#title', { color: null }).kind).toBe('none');
  });

  it('words the comment the agent gets', () => {
    expect(styleEditNote('h1.title', { 'font-size': '32px', color: null })).toBe('Set font-size: 32px; remove color on h1.title');
  });
});
