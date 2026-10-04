/** Real Electron disclosure/performance check; no LLM or user sessions. */
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
app.disableHardwareAcceleration();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'agente-subagent-ui-')));
const deadline = setTimeout(() => app.exit(1), 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await win.loadURL(process.env.AGENTE_RENDERER_URL ?? 'http://127.0.0.1:5173/?mock=1');
    const report = await win.webContents.executeJavaScript(`(async () => {
      const { mount, unmount, tick } = await import('/node_modules/.vite/deps/svelte.js');
      const { default: Card } = await import('/src/lib/features/code/SubagentCard.svelte');
      const { default: RichContent } = await import('/src/lib/ui/components/RichContent.svelte');
      const { default: Compaction } = await import('/src/lib/features/code/CompactionReport.svelte');
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const root = document.createElement('div'); root.style.cssText = 'position:fixed;inset:32px;z-index:100000;background:var(--background);overflow:auto;padding:20px'; document.body.append(root);
      const answer = '日'.repeat(150000) + ' FINAL EVIDENCE';
      const children = [];
      const start = performance.now();
      for (let i = 0; i < 24; i++) children.push(mount(Card, { target: root, props: { child: { id:'child-'+i, kind:'explore', description:'Inspect files '+i, status:'done', text:answer, summary:answer, tools:[], spend:{costUsd:0,estimated:false,unpriced:true,promptTokens:0,cacheReadTokens:0,cacheWriteTokens:0} } } }));
      await tick(); await frame();
      const mountMs = performance.now() - start;
      if (root.querySelector('.child-body')) throw new Error('Collapsed child parsed its full answer');
      const details = root.querySelector('details'); details.open = true; details.dispatchEvent(new Event('toggle'));
      await tick(); await frame(); await frame();
      if (!root.textContent.includes('FINAL EVIDENCE')) throw new Error('Expanded child lost the final answer');
      if (root.querySelectorAll('.child-body').length !== 1) throw new Error('Opening one child rendered siblings');
      mount(Compaction, { target: root, props: { report: {running:false,success:true,tokensBefore:12000,tokensAfter:4000,smart:true,requestedSmart:true,modelTokens:800,cacheReadTokens:200} } });
      await tick(); await frame();
      if (!root.textContent.includes('12,000')) throw new Error('Compaction token counts missing');
      const prose = document.createElement('div'); root.append(prose);
      const sample = mount(RichContent, { target:prose, props:{content:'## Systems\\n\\nThe terrain module reads '+ String.fromCharCode(96) +'js/island.js'+String.fromCharCode(96)+' and rebuilds the scene. '+ 'Each module has a clear responsibility. '.repeat(12) +'\\n\\n### Rendering\\n\\nWater and sky update independently; the camera keeps its position.'} });
      await tick(); await frame();
      for (const dark of [false,true]) {
        document.documentElement.classList.toggle('dark', dark);
        const paragraph = prose.querySelector('p');
        if (getComputedStyle(paragraph).textAlign !== 'left') throw new Error('Technical prose is justified');
        if (paragraph.getBoundingClientRect().width >= 1000) throw new Error('Paragraph line length is not constrained');
        if (getComputedStyle(prose.querySelector('code')).paddingTop !== '0px') throw new Error('Inline code is oversized');
      }
      await unmount(sample);
      for (const child of children) await unmount(child);
      root.remove();
      return { children:24, bytesPerReply:new TextEncoder().encode(answer).length, collapsedMountMs:mountMs };
    })()`);
    assert.equal(report.children, 24);
    assert.ok(report.bytesPerReply > 450000);
    console.log('subagent-rendering smoke:', JSON.stringify(report));
  } finally { clearTimeout(deadline); win.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
