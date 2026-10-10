// Visual pass over the Roleplay space: the library and its one-tap start, the character editor's tabs and preview,
// the scene setup behind "Customize scene", the scene header and its memory panel, the "remembered" line under a reply,
// the error row a failed generation leaves, a reply the budget trimmed to fit the window, and the roleplay settings'
// Advanced tab (local sampler and repetition), all in both themes at 990 and 1490 px. It also prints layout facts
// (document overflow, text below --text-xs, the smallest type size, raw {{macros}}) so a regression shows in the log as
// well as in the PNGs. A Vite error overlay on the page fails the run: it means the shots would show a broken build.
// Bundle: npx esbuild tests/electron/roleplay.smoke.ts --bundle --platform=node --format=cjs --external:electron --outfile=<scratch>/roleplay-smoke.cjs
// Run with a Vite dev server serving renderer/ (AGENTE_DEV_URL, default http://127.0.0.1:5173):
//   AGENTE_SHOTS=<dir> npx electron --no-sandbox <scratch>/roleplay-smoke.cjs
import { mkdtempSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

app.disableHardwareAcceleration();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-roleplay-')));
const URL_BASE = process.env.AGENTE_DEV_URL || 'http://127.0.0.1:5173';
const OUT = process.env.AGENTE_SHOTS || join(tmpdir(), 'agente-roleplay-shots');
const HEIGHT = 860;
/** The two widths the brief names. */
const WIDTHS = [990, 1490];
const THEMES = ['light', 'dark'] as const;
/** Imports a module the way the page loaded it (Vite serves hot-updated modules with a query string). */
const MOD = "const mod=async(p)=>{const u=performance.getEntriesByType('resource').map((r)=>r.name).find((n)=>n.split('?')[0].endsWith(p));return import(u||p)};";

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1490, height: HEIGHT, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') console.error(`[console ${level}]`, message.slice(0, 400)); });
  const js = <T>(source: string) => win.webContents.executeJavaScript(source) as Promise<T>;
  const pause = async (ms = 150) => { await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await new Promise((r) => setTimeout(r, ms)); };
  mkdirSync(OUT, { recursive: true });
  /** A Vite compile error paints an overlay over the app; a shot taken through it is worthless, so stop the run. */
  const assertNoOverlay = async (where: string) => {
    const overlay = await js<string | null>(`document.querySelector('vite-error-overlay') ? (document.querySelector('vite-error-overlay').shadowRoot?.textContent || 'vite-error-overlay').replace(/\\s+/g,' ').slice(0,600) : null`);
    if (overlay !== null) throw new Error(`vite-error-overlay present (${where}): ${overlay}`);
  };
  const capture = async (name: string) => {
    win.webContents.invalidate();
    await pause();
    await assertNoOverlay(name);
    await writeFile(join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    console.log('shot', name);
  };
  const missing: string[] = [];
  /** Layout or build problems the log reports; any one of them makes the run exit non-zero. */
  const problems: string[] = [];
  const click = async (x: number, y: number) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await pause(60);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await pause(300);
  };
  /** Clicks the nth visible element matching a selector, by its real pointer position. */
  const clickSelector = async (name: string, selector: string, nth = 0) => {
    const at = await js<{ x: number; y: number } | null>(`(()=>{const els=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.offsetWidth);const e=els[${nth}];if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (!at) { missing.push(name); console.log('missing control for', name); return false; }
    await pause(80);
    await click(at.x, at.y);
    return true;
  };
  /** Clicks the first visible button, menu item or tab whose label matches. */
  const press = async (name: string, pattern: string, scope = 'document') => {
    // A popup mounts a frame or two after its trigger: wait for the control rather than assume it is there.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await js<boolean>(`!!(()=>{const root=${JSON.stringify(scope)}==='document'?document:document.querySelector(${JSON.stringify(scope)});if(!root)return null;const re=new RegExp(${JSON.stringify(pattern)},'i');return [...root.querySelectorAll('button,[role=menuitem],[role=tab]')].find(e=>e.offsetWidth&&re.test(((e.getAttribute('aria-label')||'')+' '+(e.title||'')+' '+e.textContent).replace(/\\s+/g,' ').trim()))})()`)) break;
      await pause(150);
    }
    const at = await js<{ x: number; y: number } | null>(`(()=>{const root=${JSON.stringify(scope)}==='document'?document:document.querySelector(${JSON.stringify(scope)});if(!root)return null;const re=new RegExp(${JSON.stringify(pattern)},'i');const b=[...root.querySelectorAll('button,[role=menuitem],[role=tab]')].find(e=>e.offsetWidth&&re.test(((e.getAttribute('aria-label')||'')+' '+(e.title||'')+' '+e.textContent).replace(/\\s+/g,' ').trim()));if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (!at) {
      missing.push(name);
      console.log('missing control for', name, '| visible:', await js<string>(`[...document.querySelectorAll('button,[role=menuitem]')].filter(e=>e.offsetWidth).map(e=>(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,24)).slice(0,40).join(' / ')`));
      return false;
    }
    await click(at.x, at.y);
    return true;
  };
  const closeFloating = async () => {
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await pause(150);
    await js(`document.querySelector('.ui-modal-backdrop')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await pause(250);
  };
  const app$ = (code: string) => js(`(async()=>{${MOD}const {appStore:a}=await mod('/src/lib/stores/app.svelte.ts');${code}})()`);
  const rp$ = (code: string) => js(`(async()=>{${MOD}const {roleplayStore:r}=await mod('/src/lib/features/roleplay/roleplay.svelte.ts');const {appStore:a}=await mod('/src/lib/stores/app.svelte.ts');${code}})()`);
  const theme = (name: string) => js(`(async()=>{${MOD}(await mod('/src/lib/stores/theme.svelte.ts')).themeStore.set('${name}')})()`);
  /**
   * Layout facts for the log: the page does not scroll sideways, and no text in the roleplay space is smaller
   * than --text-xs (12px at 100%).
   */
  const layoutFacts = async (label: string) => {
    const facts = await js<string[]>(`(()=>{
      const out=[];
      const root=document.querySelector('.roleplay-panel');
      if(!root)return ['roleplay space not mounted'];
      const raw=document.body.innerText.match(/\\{\\{[^}]*\\}\\}/g);
      if(raw)out.push('raw macro text: '+raw.slice(0,3).join(' '));
      if(document.documentElement.scrollWidth>document.documentElement.clientWidth+1)out.push('page scrolls sideways by '+(document.documentElement.scrollWidth-document.documentElement.clientWidth)+'px');
      let smallest=Infinity;
      for(const el of document.querySelectorAll('.roleplay-panel *, [role=dialog] *')){
        if(!(el instanceof HTMLElement)||!el.offsetParent)continue;
        if(![...el.childNodes].some((n)=>n.nodeType===3&&n.textContent.trim()))continue;
        const size=parseFloat(getComputedStyle(el).fontSize);
        if(size<smallest)smallest=size;
        if(size<11.5)out.push('text below --text-xs: '+size+'px in '+String(el.className).slice(0,40));
      }
      return out.length?out:['ok (smallest text '+smallest+'px)'];
    })()`);
    console.log(`layout ${label}:`, facts.join('; '));
    for (const fact of facts) if (!fact.startsWith('ok')) problems.push(`${label}: ${fact}`);
  };

  await win.loadURL(`${URL_BASE}/?mock=1`); console.log('loaded');
  for (let i = 0; i < 100; i++) { if (await js("document.documentElement.dataset.desktopReady==='true'")) break; await pause(); }
  await assertNoOverlay('load');
  await js(`(async()=>{${MOD}const {appStore}=await mod('/src/lib/stores/app.svelte.ts');const {accessibilityStore}=await mod('/src/lib/stores/accessibility.svelte.ts');accessibilityStore.update({reduceMotion:'on'});appStore.onboardingOpen=false;})()`);
  // English labels, so the patterns below read the same in every run.
  await js(`(async()=>{${MOD}(await mod('/src/lib/i18n/index.ts')).setUiLocale('en')})()`);
  await pause(300);
  const enterRoleplay = async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await js(`document.getElementById('space-tab-roleplay')?.click()`); await pause(700);
      if (await js<string>(`(async()=>{${MOD}return (await mod('/src/lib/stores/app.svelte.ts')).appStore.activeSpace})()`) === 'roleplay') break;
    }
  };
  await enterRoleplay();
  console.log('space', await js(`(async()=>{${MOD}return (await mod('/src/lib/stores/app.svelte.ts')).appStore.activeSpace})()`));

  for (const width of WIDTHS) {
    win.setContentSize(width, HEIGHT);
    await pause(500);
    for (const name of THEMES) {
      await theme(name);
      const tag = `${width}-${name}`;

      // The landing page: the characters shelf, no chat, no composer.
      await app$(`a.openRoleplayLibrary()`);
      await pause(500);
      await capture(`${tag}-01-library`);
      await layoutFacts(`${tag} library`);

      if (width === 1490 && name === 'light') {
        const before = await app$(`return a.chats.filter((c)=>c.contextMode==='roleplay').length`);
        await press('sidebar new roleplay', '^New roleplay$', '.sidebar');
        await pause(400);
        const after = await app$(`return a.chats.filter((c)=>c.contextMode==='roleplay').length`);
        console.log(`sidebar New roleplay: roleplay chats ${before} -> ${after}`);
        await capture(`${tag}-02-new-roleplay`);

        // Card options: "Customize scene…" opens the setup with the character already in the cast.
        await clickSelector('character options', 'button[aria-label="Character options"]', 0);
        await pause(500);
        await press('customize scene', 'Customize scene');
        await pause(400);
        await capture(`${tag}-03-customize`);
        // Clear the cast to show the one-line reason Start is off.
        await clickSelector('cast chip', '.cast-option.is-on', 0);
        await pause(300);
        await capture(`${tag}-04-setup-blocked`);
        await closeFloating();

        // The editor: Basics, the openings, how they talk, lore, voice, advanced.
        await clickSelector('edit character', 'button[aria-label="Edit character"]', 0);
        await pause(400);
        await capture(`${tag}-05-editor-basics`);
        for (const [shot, pattern] of [['openings', 'Openings'], ['talk', 'How they talk'], ['lore', 'Lore'], ['voice', 'Voice'], ['advanced', 'Advanced']] as const) {
          await press(`editor ${shot}`, pattern, '[role=dialog]');
          await pause(300);
          await capture(`${tag}-06-editor-${shot}`);
        }
        await layoutFacts(`${tag} editor`);
        // The "Insert name" helper, open on the description field.
        await press('editor basics', 'Basics', '[role=dialog]');
        await pause(200);
        await press('insert name', 'Insert name', '[role=dialog]');
        await pause(400);
        await capture(`${tag}-06b-insert-name`);
        await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
        await pause(250);
        await closeFloating();

        // Persona and world editors: the same tabs, lighter.
        await press('personas shelf', 'Personas', '.roleplay-library');
        await pause(400);
        await capture(`${tag}-11-library-personas`);
        await press('new persona', 'New persona', '.roleplay-library');
        await pause(400);
        await capture(`${tag}-12-persona-editor`);
        await closeFloating();
        await press('worlds shelf', 'Worlds', '.roleplay-library');
        await pause(400);
        await capture(`${tag}-13-library-worlds`);
        await clickSelector('edit world', 'button[aria-label="Edit world"]', 0);
        await pause(400);
        await capture(`${tag}-14-world-editor`);
        for (const [shot, pattern] of [['openings', 'Openings'], ['defaults', 'Scene defaults']] as const) {
          await press(`world ${shot}`, pattern, '[role=dialog]');
          await pause(300);
          await capture(`${tag}-15-world-${shot}`);
        }
        await closeFloating();
        // The scene setup from a world: the cast, the persona and the openings, with the hint on Start.
        await press('worlds shelf', 'Worlds', '.roleplay-library');
        await pause(300);
        await clickSelector('world card', '.lib-card .card-hit', 0);
        await pause(500);
        await capture(`${tag}-16-world-setup`);
        await closeFloating();
        await press('characters shelf', 'Characters', '.roleplay-library');
        await pause(300);
      }

      // One tap: the first character starts a scene with its greeting.
      await clickSelector('character card', '.lib-card .card-hit', 0);
      await pause(600);
      await capture(`${tag}-07-scene`);
      await layoutFacts(`${tag} scene`);

      // Memory, a reply the budget trimmed, the error row, and the roleplay settings: every width and theme.
      await rp$(`const c=a.currentChat;const first=c.messages[0];r.pinToMemory(first.content);r.addJournalEntry({kind:'quest',title:'Find the ferryman',body:'He owes the crossing a favour.'});`);
      await press('memory', 'Memory', '.roleplay-panel');
      await pause(400);
      await capture(`${tag}-08-memory`);
      await closeFloating();

      // A reply the prompt builder wrote from memory: the turn's own prepareTurn/finalize, so the stored recall is real.
      // The budget trimmed the example dialogue, two lore entries and six older messages to fit the window.
      await rp$(`const c=a.currentChat;const turn=r.prepareTurn(c,{speakerId:c.characterId});const rec=turn.snapshot?.recall;turn.noteUsed({lore:(rec?.lore??[]).map((e)=>e.id),memories:rec?.summary?['summary']:[],journal:(rec?.memories??[]).map((m)=>m.id),trimmed:[{kind:'examples',count:1},{kind:'lore',count:2},{kind:'descriptions',count:1},{kind:'history',count:6}]});const target={content:'*The lamp flickers, and the ferryman looks up.* "You came back."',choices:[],props:[],metadata:{}};turn.finalize(target);a.appendMessageToChat(c.id,{id:'msg-recall-demo',role:'assistant',content:target.content,createdAt:Date.now(),done:true,status:'idle',model:'',speakerId:c.characterId,versions:[],activeVersion:0,mode:'chat',metadata:target.metadata});`);
      await pause(400);
      await capture(`${tag}-09a-trim-note`);
      await clickSelector('remembered toggle', '.recall-toggle', 0);
      await pause(300);
      await capture(`${tag}-09-remembered`);
      await layoutFacts(`${tag} remembered`);

      // A failed generation: an error row with Retry, never a character's line.
      await rp$(`const c=a.currentChat;a.appendMessageToChat(c.id,{id:'msg-error-demo',role:'assistant',content:'Failed to start chat stream',createdAt:Date.now(),done:true,status:'error',model:'',speakerId:c.characterId,versions:[],activeVersion:0,mode:'chat',metadata:{error:true,errorMessage:'Failed to start chat stream'}});`);
      await pause(400);
      await capture(`${tag}-10-error-row`);
      await layoutFacts(`${tag} error row`);

      // The roleplay settings, then the Advanced tab with the local sampler and repetition selects.
      await clickSelector('roleplay settings', 'button[aria-label="Roleplay settings"]', 0);
      await pause(500);
      await capture(`${tag}-17-settings`);
      await press('settings advanced', 'Advanced', '[role=dialog]');
      await pause(300);
      await capture(`${tag}-18-settings-advanced`);
      await layoutFacts(`${tag} settings advanced`);
      await closeFloating();

      // Back to the landing page for the next pass.
      await app$(`a.openRoleplayLibrary()`);
      await pause(300);
    }
  }

  console.log(missing.length ? `missing controls: ${missing.join(', ')}` : 'all controls found');
  if (missing.length) problems.push(`missing controls: ${missing.join(', ')}`);
  if (problems.length) {
    console.error(`roleplay smoke found ${problems.length} problem(s):\n${problems.join('\n')}`);
    app.exit(1);
  }
  app.quit();
}

app.whenReady().then(run).catch((error) => {
  console.error(error);
  app.exit(1);
});
