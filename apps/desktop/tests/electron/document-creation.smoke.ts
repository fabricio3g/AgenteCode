/** All six document generators and their real viewers, including keyboard find.
 * Serve renderer/ on port 5178, bundle this harness with esbuild and run it
 * under Electron. Native dependencies stay external, as in build-bundles.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { generateDocx, generateXlsx, generatePdf } from '../../main/generated-documents.ts';
import { generatePptx } from '../../main/slides.ts';
import { convertFileToMarkdown } from '../../main/document-markdown.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-document-create-'));
process.env.AGENTE_HOME = root;
app.setPath('userData', path.join(root, 'browser'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
async function run() {
  await app.whenReady();
  ipcMain.handle('generate_docx', (_e, { data }) => generateDocx(data));
  ipcMain.handle('generate_xlsx', (_e, { data }) => generateXlsx(data));
  ipcMain.handle('generate_pdf', (_e, { data }) => generatePdf(data));
  ipcMain.handle('generate_pptx', (_e, { data }) => generatePptx(data));
  ipcMain.handle('window:set-titlebar-overlay', () => true);
  const out = process.env.AGENTE_DOCUMENT_OUTPUT || path.join(root, 'output');
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: {
    offscreen: true, preload: path.resolve('preload/preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') console.error(message.slice(0, 400)); });
  const js = (code: string) => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(`${process.env.AGENTE_DEV_URL || 'http://127.0.0.1:5178'}/tests/ingestion-harness.html`);
    const sample = {
      title: 'Quarterly Métricas', subtitle: 'Source-based management review',
      executiveSummary: 'The source ledger records 12.5% growth and a total of 42 USD. The report preserves the original values and identifies the limits of available evidence.',
      sections: [
        { title: 'Findings', content: 'Growth **rate** was **12.5%**. The source records a total of 42 USD.\n\n1. Validate the source ledger.\n2. Review supplier risk.\n\n[Evidence](https://example.com/source)', citations: ['ledger.xlsx · Sales · row 2'] },
        { title: 'Method', content: 'Use the source records and preserve their units.\n\n> Forecasts are unavailable.\n\n```sql\nSELECT 42;\n```' },
      ],
      tables: [{ name: 'Sales', columns: [{ key: 'item', header: 'Item' }, { key: 'usd', header: 'USD', numFmt: '$#,##0.00', width: 20 }], rows: [{ item: 'Revenue', usd: 42 }, { item: 'Costs', usd: 12.5 }] }],
      metrics: [{ label: 'Growth', value: '12.5%', note: 'Source measurement' }],
      sources: [{ id: '1', title: 'ledger.xlsx', snippet: 'Revenue 42 USD; costs 12.5 USD.' }], limitations: ['No future forecast is available.'],
      formats: ['md', 'html', 'docx', 'xlsx', 'pdf', 'pptx'], path: 'quarterly-report',
    };
    const files = await js(`(async () => {
      await import('/src/app.css'); await import('/src/lib/i18n/index.ts');
      const {locale}=await import('/node_modules/.vite/deps/svelte-i18n.js');locale.set('en');
      const {createWorkProductArtifactFiles}=await import('/src/lib/services/generated-documents.ts');
      const {mount,unmount}=await import('/node_modules/.vite/deps/svelte.js');
      const {default:DocumentViewer}=await import('/src/lib/features/chat/DocumentViewer.svelte');
      const generated=await createWorkProductArtifactFiles(${JSON.stringify(sample)});
      document.body.innerHTML='<main id="fixture" style="height:100vh;display:flex;min-height:0"></main>';
      window.fixture={files:generated.files,instance:null,mount,unmount,DocumentViewer};
      return generated.files.map(f=>({path:f.path,dataUrl:f.dataUrl,spec:f.spec,previewHtml:f.previewHtml}));
    })()`);
    for (const file of files) {
      const filename = path.join(out, path.basename(file.path));
      fs.writeFileSync(filename, Buffer.from(file.dataUrl.split(',')[1], 'base64'));
      const { markdown } = await convertFileToMarkdown(filename);
      assert.match(markdown, /12\.5/); assert.match(markdown, /42/); assert.match(markdown, /ledger\.xlsx/);
    }
    const views: string[] = [];
    for (const profile of [{name:'light',theme:'light',width:1000,scale:1},{name:'dark',theme:'dark',width:1000,scale:1},{name:'narrow',theme:'light',width:440,scale:1},{name:'large-text',theme:'dark',width:1000,scale:2}]) {
      const theme = profile.theme; win.setSize(profile.width, 850);
      for (const file of files) {
        const ext = path.extname(file.path).slice(1);
        await js(`(async()=>{
          const f=window.fixture;if(f.instance)await f.unmount(f.instance);
          document.documentElement.classList.toggle('dark',${JSON.stringify(theme)}==='dark');
          document.documentElement.style.setProperty('--reading-scale', ${JSON.stringify(String(1))});
          document.documentElement.style.setProperty('--reading-scale',${JSON.stringify('')} || ${profile.scale});
          const file=f.files.find(x=>x.path===${JSON.stringify(file.path)});
          const bytes=Uint8Array.from(atob(file.dataUrl.split(',')[1]),c=>c.charCodeAt(0));
          const content=${JSON.stringify(ext)}==='md'||${JSON.stringify(ext)}==='html'?new TextDecoder().decode(bytes):undefined;
          f.instance=f.mount(f.DocumentViewer,{target:document.getElementById('fixture'),props:{doc:{id:file.path,name:file.path,
            dataUrl:file.dataUrl,content,previewHtml:file.previewHtml,deck:file.spec?.deck,kind:${JSON.stringify(ext)}==='md'?'report':'document'}}});
          for(let i=0;i<250;i++){await new Promise(r=>setTimeout(r,40));if(document.querySelector('.ui-async-state.error'))throw new Error(document.querySelector('.ui-async-state.error').textContent);if(!document.querySelector('.ui-async-state'))break;}
        })()`);
        const ready = await js(`(()=>{
          if(document.querySelector('.ui-async-state'))return false;
          return !!document.querySelector(${JSON.stringify({ md: '.doc-article', html: '.html-page', docx: 'section.docx', xlsx: '.sheet-grid', pdf: '.pdf-canvas', pptx: '.slide' }[ext as 'md'])});
        })()`);
        assert.ok(ready, `${ext} viewer must finish rendering`);
        const fits = await js(`document.querySelector('.viewer-toolbar').scrollWidth <= document.querySelector('.viewer-toolbar').clientWidth + 2`);
        assert.ok(fits, `${ext} toolbar must fit ${profile.name}`);
        win.webContents.invalidate();
        await new Promise((resolve) => setTimeout(resolve, 250));
        fs.writeFileSync(path.join(out, `${ext}-${profile.name}.png`), (await win.webContents.capturePage()).toPNG());
        if (profile.name === 'light' && ['md', 'docx', 'pdf', 'pptx'].includes(ext)) {
          const count = await js(`(async()=>{
            const root=document.querySelector('.doc-viewer');root.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}));
            await new Promise(r=>setTimeout(r,30));const input=document.querySelector('.viewer-find input');
            if(!input)throw new Error('Find unavailable');input.value='12.5';input.dispatchEvent(new Event('input',{bubbles:true}));
            for(let i=0;i<250;i++){await new Promise(r=>setTimeout(r,40));const text=document.querySelector('.viewer-find [aria-live]')?.textContent||'';if(/\\/[1-9]/.test(text))return text;}
            return document.querySelector('.viewer-find [aria-live]')?.textContent;
          })()`);
          assert.match(count, /\/[1-9]/, `${ext} search must find a decimal source value`);
        }
        views.push(`${ext}-${profile.name}`);
      }
    }
    await js('(async()=>{if(window.fixture.instance)await window.fixture.unmount(window.fixture.instance)})()');
    fs.writeFileSync(path.join(out, 'validation.json'), JSON.stringify({ formats: files.map((file: { path: string }) => file.path), views, factsRetained: true, searchVerified: true }, null, 2));
    console.log(JSON.stringify({ status: 'passed', output: out, formats: files.length, views: views.length }));
  } finally { win.destroy(); }
}
run().then(() => app.quit(), (error) => { console.error(error); app.exit(1); });
