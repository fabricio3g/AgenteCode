// Visual pass over the Design space: the docked chat, canvas tools, toolbar menus, side panes at four widths,
// drag and keyboard resizing, the motion timeline and the Inspector's motion tokens, in both themes. It also prints layout facts (toolbar overflow, panes inside the
// surface, the pill inside the canvas, the smallest type size) so a regression shows up in the log as well as in the PNGs.
// Bundle: npx esbuild tests/electron/design-space.smoke.ts --bundle --platform=node --format=cjs --external:electron --outfile=<scratch>/design-smoke.cjs
// Run with a Vite dev server serving renderer/ (AGENTE_DEV_URL, default http://127.0.0.1:5173):
//   AGENTE_SHOTS=<dir> npx electron --no-sandbox <scratch>/design-smoke.cjs
import { mkdtempSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

app.disableHardwareAcceleration();
// The canvas frame is an opaque-origin sandbox, which Chromium puts in a process of its own; the offscreen view does not
// route pointer input into that process, so the picker never sees a click. Site isolation is off for this harness only.
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-design-')));
const URL_BASE = process.env.AGENTE_DEV_URL || 'http://127.0.0.1:5173';
const OUT = process.env.AGENTE_SHOTS || join(tmpdir(), 'agente-design-shots');
const HEIGHT = 860;
/** The narrowest supported window, the two the brief names, and the default. */
const WIDTHS = [820, 990, 1280, 1490];
const THEMES = ['light', 'dark'] as const;
/**
 * Imports a module the way the page loaded it. Vite serves a module it has hot-updated as `file.ts?t=…`, and a bare
 * import is then a second copy of the store that the app never renders, so the page is asked which URL it used.
 */
const MOD = "const mod=async(p)=>{const u=performance.getEntriesByType('resource').map((r)=>r.name).find((n)=>n.split('?')[0].endsWith(p));return import(u||p)};";

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1490, height: HEIGHT, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error' || level === 'warning') console.error(`[console ${level}]`, message.slice(0, 400)); });
  const js = <T>(source: string) => win.webContents.executeJavaScript(source) as Promise<T>;
  const pause = async (ms = 150) => { await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await new Promise((r) => setTimeout(r, ms)); };
  mkdirSync(OUT, { recursive: true });
  const capture = async (name: string) => {
    win.webContents.invalidate();
    await pause();
    await writeFile(join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    console.log('shot', name);
  };
  const missing: string[] = [];
  const click = async (x: number, y: number, modifiers: Array<'shift'> = []) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers }); await pause(60);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1, modifiers });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1, modifiers }); await pause(250);
  };
  /** A drag from (x, y) by dx px in eight steps, the way a pointer moves. */
  const drag = async (x: number, y: number, dx: number) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await pause(40);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 8; step += 1) { win.webContents.sendInputEvent({ type: 'mouseMove', x: x + (dx * step) / 8, y }); await pause(30); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x + dx, y, button: 'left', clickCount: 1 }); await pause(250);
  };
  /**
   * Clicks the first visible button, menu item or tab whose label, title or text matches, searching `scope` (a selector,
   * so the activity rail's own "Code" button is never a match for the inspector's tab); logs a miss.
   */
  const press = async (name: string, pattern: string, scope = 'document') => {
    const ok = await js<boolean>(`(()=>{const root=${JSON.stringify(scope)}==='document'?document:document.querySelector(${JSON.stringify(scope)});if(!root)return false;const re=new RegExp(${JSON.stringify(pattern)},'i');const b=[...root.querySelectorAll('button,[role=menuitem],[role=tab]')].find(e=>e.offsetWidth&&re.test((e.getAttribute('aria-label')||'')+' '+(e.title||'')+' '+e.textContent));if(b){b.click();return true}return false})()`);
    if (!ok) { missing.push(name); console.log('missing control for', name); }
    return ok;
  };
  /** Escape closes a menu; a dialog also takes a click on its backdrop. */
  const closeFloating = async () => {
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await pause(150);
    await js(`document.querySelector('.ui-modal-backdrop')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await pause();
  };
  /** Runs a snippet against the open design's store (the harness reads the app through its modules). */
  const store = (code: string) => js(`(async()=>{${MOD}const {designStore:d}=await mod('/src/lib/features/design/design.svelte.ts');${code}})()`);
  const theme = (name: string) => js(`(async()=>{${MOD}(await mod('/src/lib/stores/theme.svelte.ts')).themeStore.set('${name}')})()`);
  /** The sidebar decides the canvas width, and with it the toolbar's plan: wide with it closed, compact with it open. */
  const sidebar = (open: boolean) => js(`(async()=>{${MOD}(await mod('/src/lib/stores/app.svelte.ts')).appStore.sidebarOpen=${open}})()`);
  /**
   * Screen coordinates of a point inside the canvas frame. The frame is sandboxed without same-origin, so its document
   * cannot be read; `page` is the point in the mock page's own coordinates, measured once from the mock workspace.
   */
  const inFrame = (page: { x: number; y: number }) => js<{ x: number; y: number } | null>(`(()=>{const f=document.querySelector('.design-surface iframe');if(!f)return null;const fr=f.getBoundingClientRect();const m=new DOMMatrix(getComputedStyle(f).transform);const s=m.a||1;return {x:fr.left+${page.x}*s,y:fr.top+${page.y}*s}})()`);
  /**
   * The mock page's heading, call to action and paragraph, in page coordinates: `main` is 720px centred in the 1440px
   * frame with 64px of top padding, so the heading box is 376, 64 (688 × 54) and the paragraph starts at 376, 134.
   */
  const HEADING = { x: 420, y: 90 };
  const ACTION = { x: 440, y: 214 };
  const PARAGRAPH = { x: 420, y: 146 };
  const paneWidths = () => js<{ dock: number; inspector: number; canvas: number; surface: number }>(`(()=>{const w=(s)=>document.querySelector(s)?.getBoundingClientRect().width??0;return {dock:w('.design-surface .pane.dock:not(.closed)'),inspector:w('.design-surface .pane.side'),canvas:w('.design-surface .canvas-column'),surface:w('.design-surface')}})()`);
  /** Centres of the pane edges, in DOM order: the chat's edge, then the inspector's. */
  const edgeCentre = (index: number) => js<{ x: number; y: number } | null>(`(()=>{const h=document.querySelectorAll('.design-surface .edge [role=separator]')[${index}];if(!h)return null;const r=h.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  /**
   * Layout facts for the log: the toolbar must not overflow its row, the pill must sit inside the canvas column,
   * panes stay inside the surface, and no text in the design space is smaller than --text-xs (12px at 100%).
   */
  const layoutFacts = async (label: string) => {
    const facts = await js<string[]>(`(()=>{
      const out=[];
      const surface=document.querySelector('.design-surface');
      if(!surface)return ['design space not mounted'];
      const toolbar=document.querySelector('.design-surface .toolbar');
      if(toolbar&&toolbar.scrollWidth>toolbar.clientWidth+1)out.push('toolbar overflows by '+(toolbar.scrollWidth-toolbar.clientWidth)+'px');
      const column=document.querySelector('.design-surface .canvas-column')?.getBoundingClientRect();
      const pill=document.querySelector('.design-surface .pill')?.getBoundingClientRect();
      if(column&&pill&&(pill.left<column.left-0.5||pill.right>column.right+0.5))out.push('pill leaves the canvas column');
      if(column&&column.width<351)out.push('canvas narrower than its minimum: '+Math.round(column.width)+'px');
      const sr=surface?.getBoundingClientRect();
      for(const sel of ['.design-surface .pane.dock:not(.closed)','.design-surface .pane.side']){const el=document.querySelector(sel);if(!el||!sr)continue;const r=el.getBoundingClientRect();if(r.right>sr.right+0.5||r.left<sr.left-0.5)out.push(sel+' leaves the surface');}
      let smallest=Infinity;
      for(const el of document.querySelectorAll('.design-surface *')){
        if(!(el instanceof HTMLElement)||(!el.offsetParent&&el.tagName!=='BODY'))continue;
        if(![...el.childNodes].some((n)=>n.nodeType===3&&n.textContent.trim()))continue;
        const size=parseFloat(getComputedStyle(el).fontSize);
        if(size<smallest)smallest=size;
        if(size<11.5)out.push('text below --text-xs: '+size+'px in '+String(el.className).slice(0,40));
      }
      return out.length?out:['ok (smallest text '+smallest+'px)'];
    })()`);
    console.log(`layout ${label}:`, facts.join('; '));
  };

  await win.loadURL(`${URL_BASE}/?mock=1`); console.log('loaded');
  for (let i = 0; i < 100; i++) { if (await js("document.documentElement.dataset.desktopReady==='true'")) break; await pause(); }
  await js(`(async()=>{${MOD}const {appStore}=await mod('/src/lib/stores/app.svelte.ts');const {accessibilityStore}=await mod('/src/lib/stores/accessibility.svelte.ts');accessibilityStore.update({reduceMotion:'on'});appStore.onboardingOpen=false;})()`);
  // English labels, so the patterns below read the same in every run.
  await js(`(async()=>{${MOD}(await mod('/src/lib/i18n/index.ts')).setUiLocale('en')})()`);
  await pause(300);
  // The locale switch can land after the first click, so the space is asked for until it sticks.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await js(`document.getElementById('space-tab-design')?.click()`); await pause(700);
    if (await js<string>(`(async()=>{${MOD}return (await mod('/src/lib/stores/app.svelte.ts')).appStore.activeSpace})()`) === 'design') break;
  }
  console.log('space', await js(`(async()=>{${MOD}return (await mod('/src/lib/stores/app.svelte.ts')).appStore.activeSpace})()`));

  for (const name of THEMES) {
    await theme(name);

    // Wide canvas (sidebar closed, inspector closed): every control on the row, the menus and dialogs from it.
    await sidebar(false);
    await store(`d.setTool('browse');d.clearSelection();d.clearComments();d.setZoom(null);d.tray=null;if(!d.chatOpen)d.toggleChat();if(d.inspectorOpen)d.toggleInspector();`);
    await pause(500);
    await capture(`${name}-01-overview`);
    await layoutFacts(`${name} wide overview`);

    await store(`d.setTool('select')`); await pause(300);
    const h1 = await inFrame(HEADING); if (h1) { win.webContents.sendInputEvent({ type: 'mouseMove', x: h1.x, y: h1.y }); await pause(200); }
    await capture(`${name}-02-select-hover`);
    // Real picks through the canvas: a click selects the heading, a shift+click adds the call to action.
    if (h1) await click(h1.x, h1.y);
    const action = await inFrame(ACTION);
    if (action) await click(action.x, action.y, ['shift']);
    if (await js<number>(`(async()=>{${MOD}return (await mod('/src/lib/features/design/design.svelte.ts')).designStore.selection.length})()`) < 2) {
      // The store fallback keeps the chips on screen when a click misses the frame.
      await store(`d.clearSelection();d.addSelection({selector:'h1',tag:'h1',text:'A calmer way to plan',html:'<h1>A calmer way to plan</h1>',box:{x:376,y:64,width:688,height:54},styles:{'font-size':'36px','font-weight':'400','line-height':'54px'}},false);d.addSelection({selector:'a',tag:'a',text:'Get started',html:'<a>Get started</a>',box:{x:376,y:190,width:125,height:48},styles:{'background-color':'rgb(59, 91, 219)'}},true);`);
    }
    await store(`d.setTool('browse')`); await pause(200);
    await capture(`${name}-03-selected-chips`);
    // Many picks: the chips take two lines at most and a +N chip stands for the rest; the +N chip expands them.
    if (name === 'light') {
      const chipState = () => js<string>(`(()=>{const c=document.querySelector('.design-surface .chips');if(!c)return 'no chips';const tops=[...c.children].map((e)=>Math.round(e.getBoundingClientRect().top));const more=[...c.querySelectorAll('.more-chip')].map((e)=>e.textContent.trim());return 'lines '+new Set(tops).size+', items '+c.children.length+', more '+(more.join(',')||'none')})()`);
      await store(`for(let i=0;i<6;i++)d.addComment({page:d.selected,selector:'p',x:376,y:134,note:'Note '+(i+1)+' about the spacing and the type scale'});`);
      await pause(400);
      console.log('chips packed:', await chipState());
      await capture(`${name}-03b-chips-packed`);
      await js(`document.querySelector('.design-surface .chips .more-chip')?.click()`); await pause(400);
      console.log('chips expanded:', await chipState());
      await capture(`${name}-03c-chips-expanded`);
      await js(`[...document.querySelectorAll('.design-surface .chips button')].find((b) => b.textContent.trim() === 'Show fewer')?.click()`); await pause(400);
      await store(`d.clearComments()`); await pause(300);
    }

    // A comment: the comment tool pins to the paragraph; its note is typed into the draft and sent with Enter.
    await store(`d.setTool('comment')`); await pause(300);
    const p = await inFrame(PARAGRAPH); if (p) await click(p.x, p.y);
    await pause(200);
    await capture(`${name}-04-comment-draft`);
    if (await js<boolean>(`!!document.querySelector('.draft input')`)) {
      await js(`document.querySelector('.draft input')?.focus()`);
      win.webContents.insertText('Make the subtitle lighter');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await pause(300);
    } else {
      missing.push('comment draft');
      await store(`d.addComment({page:d.selected,selector:'p',x:376,y:134,note:'Make the subtitle lighter'});`);
    }
    await store(`d.setTool('browse')`); await pause(200);
    await closeFloating();

    const TOOLBAR = '.design-surface .toolbar';
    const INSPECTOR = '.design-surface .inspector';
    const menus: Array<[string, string, string]> = [
      ['05-export-menu', '^\\s*export\\b', 'export'],
      ['06-zoom-menu', '^Zoom Zoom ', 'zoom'],
      ['07-system-menu', 'design system', 'design system'],
      ['08-variants', '^variants\\s', 'variants'],
      ['09-versions', '^versions\\s', 'versions']
    ];
    for (const [shot, pattern, control] of menus) {
      if (await press(control, pattern, TOOLBAR)) { await pause(300); await capture(`${name}-${shot}`); }
      await closeFloating();
    }
    // The handoff and the systems library open from their menus.
    if (await press('export for handoff', '^\\s*export\\b', TOOLBAR)) {
      await pause(300);
      if (await press('handoff item', 'hand off to code')) { await pause(400); await capture(`${name}-10-handoff-dialog`); }
    }
    await closeFloating();
    if (await press('system menu for library', 'design system', TOOLBAR)) {
      await pause(300);
      if (await press('manage systems', 'manage systems')) { await pause(400); await capture(`${name}-11-systems-dialog`); }
    }
    await closeFloating();
    await store(`d.setZoom(1.5)`); await pause(300);
    await capture(`${name}-12-zoom-150`);
    await store(`d.setZoom(null)`); await pause(200);

    // Compact canvas (sidebar open, inspector open): the inspector, and the More menu holding what the row drops.
    await sidebar(true);
    await store(`if(!d.inspectorOpen)d.toggleInspector()`); await pause(500);
    await capture(`${name}-13-inspector-element`);
    if (await press('inspector tokens', '^\\s*tokens', INSPECTOR)) {
      await pause(300); await capture(`${name}-14-inspector-tokens`);
      // The motion group sits below the colours and sizes: scroll the tab to it.
      await js(`document.querySelector('.design-surface .inspector .body')?.scrollTo(0, 99999)`); await pause(300);
      await capture(`${name}-14b-inspector-motion`);
      await js(`document.querySelector('.design-surface .inspector .body')?.scrollTo(0, 0)`);
    }
    if (await press('inspector code', '^\\s*code', INSPECTOR)) { await pause(300); await capture(`${name}-15-inspector-code`); }
    await press('inspector element', '^\\s*element', INSPECTOR); await pause(200);
    await layoutFacts(`${name} compact with inspector`);
    if (await press('more-menu', '^More ', TOOLBAR)) { await pause(300); await capture(`${name}-16-more-menu`); }
    await closeFloating();

    // The timeline strip: the page's animations on one axis. A row outlines its target; "Change this animation" adds the
    // target to the chips; the reduced preview cuts durations; the M key opens and closes the strip.
    await store(`d.setTool('browse');d.clearSelection();d.clearComments();`);
    if (await press('timeline', '^Timeline\\s*$', TOOLBAR)) { await pause(700); await capture(`${name}-17-timeline`); }
    await js(`document.querySelector('.timeline .row')?.click()`); await pause(400);
    await capture(`${name}-18-timeline-target`);
    if (await press('change this animation', 'Change this animation', '.timeline')) { await pause(400); await capture(`${name}-19-timeline-chip`); }
    await js(`document.querySelector('.timeline [role=switch]')?.click()`); await pause(500);
    await capture(`${name}-20-timeline-reduced`);
    await js(`document.querySelector('.timeline [role=switch]')?.click()`); await pause(200);
    await js(`[...document.querySelectorAll('.timeline button')].find((b) => b.textContent.trim() === '0.25×')?.click()`); await pause(200);
    await js(`[...document.querySelectorAll('.timeline button')].find((b) => b.textContent.trim() === '1×')?.click()`); await pause(200);
    // The M key closes the strip (the focus is on the page, outside any field).
    await js(`document.activeElement?.blur?.()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'M' });
    await pause(300);
    const closedByKey = await js<boolean>(`!document.querySelector('.timeline')`);
    console.log(`timeline M key closes: ${closedByKey ? 'ok' : 'NO'}`);
    if (!closedByKey) await js(`document.querySelector('.timeline header button[aria-label="Close timeline"]')?.click()`);
    await pause(200);
  }

  // Widths, light theme, sidebar open and the inspector open: the sheet and the inline layouts side by side.
  await theme('light');
  await store(`d.tray=null;if(!d.chatOpen)d.toggleChat();if(!d.inspectorOpen)d.toggleInspector();`);
  for (const width of WIDTHS) {
    win.setSize(width, HEIGHT); await pause(500);
    await capture(`light-w${width}-inspector`);
    console.log('panes', width, JSON.stringify(await paneWidths()));
    await layoutFacts(`light ${width}`);
  }
  // The narrowest window: the More menu, and the sheet over the canvas.
  win.setSize(820, HEIGHT); await pause(500);
  if (await press('more-menu 820', '^More ', '.design-surface .toolbar')) { await pause(300); await capture('light-w820-more-menu'); }
  await closeFloating();

  // Resizing at 1490: drag the chat edge and the inspector edge, double-click to reset, then nudge with the keyboard.
  win.setSize(1490, HEIGHT); await pause(500);
  await store(`d.resetPaneWidth('dock');d.resetPaneWidth('inspector')`); await pause(300);
  const before = await paneWidths();
  const dockEdge = await edgeCentre(0);
  if (dockEdge) await drag(dockEdge.x, dockEdge.y, 80);
  const afterDock = await paneWidths();
  console.log('drag chat edge +80: dock', Math.round(before.dock), '->', Math.round(afterDock.dock));
  await capture('light-resize-chat-dragged');
  const inspectorEdge = await edgeCentre(1);
  if (inspectorEdge) await drag(inspectorEdge.x, inspectorEdge.y, -60);
  const afterInspector = await paneWidths();
  console.log('drag inspector edge -60: inspector', Math.round(afterDock.inspector), '->', Math.round(afterInspector.inspector));
  await capture('light-resize-inspector-dragged');
  const again = await edgeCentre(0);
  if (again) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: again.x, y: again.y }); await pause(60);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: again.x, y: again.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: again.x, y: again.y, button: 'left', clickCount: 1 }); await pause(60);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: again.x, y: again.y, button: 'left', clickCount: 2 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: again.x, y: again.y, button: 'left', clickCount: 2 }); await pause(300);
  }
  const afterReset = await paneWidths();
  console.log('double-click chat edge: dock', Math.round(afterReset.dock), 'back to default', Math.round(before.dock));
  await js(`document.querySelectorAll('.design-surface .edge [role=separator]')[1]?.focus()`);
  await js(`document.querySelectorAll('.design-surface .edge [role=separator]')[1]?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`); await pause(300);
  console.log('keyboard ArrowLeft on inspector edge: inspector', Math.round(afterInspector.inspector), '->', Math.round((await paneWidths()).inspector));
  await capture('light-resize-keyboard');

  console.log(missing.length ? `missing controls: ${missing.join(', ')}` : 'all controls found');
  app.quit();
}
run().catch((error) => { console.error(error); app.exit(1); });
