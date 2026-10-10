/** Real Electron PDF rendering/OCR, indexing and artifact IPC. No model fees.
 * Serve renderer/ with Vite on AGENTE_DEV_URL (default http://127.0.0.1:5178).
 * Bundle with esbuild, externalizing electron, sharp and native RAG packages.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app, BrowserWindow, ipcMain } from 'electron';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-ingest-electron-'));
process.env.AGENTE_HOME = root;
app.setPath('userData', path.join(root, 'browser'));
app.disableHardwareAcceleration();
// The temporary PDF printer closes before the reader opens.
app.on('window-all-closed', () => {});

async function run() {
  await app.whenReady();
  const { ingestDocument, readIngestedDocument } = await import('../../main/rag-engine.ts');
  const { generateDocx, generateXlsx } = await import('../../main/generated-documents.ts');
  const { writeTempFile } = await import('../../main/filesystem.ts');
  const { saveChatSession } = await import('../../main/chat-db.ts');
  saveChatSession({ id: 'ocr-smoke', title: 'OCR verification', contextMode: 'home', messages: [], createdAt: Date.now(), updatedAt: Date.now() });
  ipcMain.handle('ingest_document', (_e, { payload }) => ingestDocument(payload));
  ipcMain.handle('read_ingested_document', (_e, { payload }) => readIngestedDocument(payload));
  ipcMain.handle('write_temp_file', (_e, { name, data }) => writeTempFile(name, data));
  ipcMain.handle('generate_docx', (_e, { data }) => generateDocx(data));
  ipcMain.handle('generate_xlsx', (_e, { data }) => generateXlsx(data));
  ipcMain.handle('window:set-titlebar-overlay', () => true);
  const picture = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="280"><rect width="1000" height="280" fill="white"/><text x="60" y="100" font-family="DejaVu Sans" font-size="54" fill="black">Invoice total 42 USD</text><text x="60" y="200" font-family="DejaVu Sans" font-size="40" fill="black">Supplier review in October</text></svg>')).jpeg().toBuffer();
  const printer = new BrowserWindow({ show: false });
  await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<style>@page{size:A4;margin:1cm}.page{break-after:page}</style><div class="page"><h1>Digital opening page</h1></div><div class="page"><img style="width:100%" src="data:image/jpeg;base64,${picture.toString('base64')}"/></div><div><h1>Digital closing page</h1></div>`)}`);
  const pdf = await printer.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true });
  printer.destroy();
  const win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: { offscreen: true,
    preload: path.resolve('preload/preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') console.error(message.slice(0, 300));
    else if (message.startsWith('OCR progress')) console.log(message);
  });
  try {
    // A resource document gives the harness the dev-server origin without
    // booting another copy of the user's application/store.
    await win.loadURL(`${process.env.AGENTE_DEV_URL || 'http://127.0.0.1:5178'}/tests/ingestion-harness.html`);
    const report = await win.webContents.executeJavaScript(`(async () => {
      window.addEventListener('ocr-progress', event => console.log('OCR progress',JSON.stringify(event.detail)));
      const { invoke } = await import('/src/lib/services/bridge.ts');
      const { ingestAttachment } = await import('/src/lib/services/attachment-ingestion.ts');
      const { extractFileContent } = await import('/src/lib/services/ocr.ts');
      const { runHomeTool } = await import('/src/lib/services/agent-tool-home.ts');
      const { createWorkProductArtifactFiles } = await import('/src/lib/services/generated-documents.ts');
      const bytes = Uint8Array.from(atob(${JSON.stringify(pdf.toString('base64'))}), c => c.charCodeAt(0));
      const file = new File([bytes], 'mixed-scan.pdf', {type:'application/pdf'});
      const attachment = await ingestAttachment(file, {id:'scan',name:file.name,size:file.size,type:file.type,status:'processing'}, 'ocr-smoke', {
        visionAvailable: async () => false,
        dataUrl: (blob) => new Promise(resolve => {const r=new FileReader();r.onload=()=>resolve(r.result);r.readAsDataURL(blob)}),
        writeFile: (name,data) => invoke('write_temp_file',{name,data:Array.from(data)}),
        ingest: payload => invoke('ingest_document',{payload}), extractFallback: extractFileContent
      });
      if(attachment.status !== 'ready') throw new Error(attachment.error || 'Ingest failed');
      const d = {
        attachments:()=>[attachment], readWorkspaceBinary:async()=>new ArrayBuffer(0),
        dataUrlBytes:async()=>new ArrayBuffer(0), visionAvailable:async()=>false,
        ocr:async()=>{throw new Error('OCR must not repeat')}, transcribe:async()=>'',
        readIngested:(chat_id,doc_id)=>invoke('read_ingested_document',{payload:{chat_id,doc_id}})
      };
      const read = await runHomeTool('read_document', {range:'2'}, {chatId:'ocr-smoke',files:{},executionMode:'sandbox'}, d);
      const spec = {title:'Invoice review', executiveSummary:'The uploaded invoice records a total of 42 USD and an October supplier review.',
        sections:[{title:'Findings',content:'The scanned invoice records a total of 42 USD. Its supplier review is scheduled for October. The digital opening and closing pages provide the document boundaries.',citations:['mixed-scan.pdf · page 2']}],
        tables:[{name:'Invoice',columns:['Item','USD'],rows:[['Invoice total',42]]}],
        sources:[{id:'1',title:'mixed-scan.pdf · page 2',snippet:'Invoice total 42 USD'}], formats:['docx','xlsx','md','html']};
      const generated = await createWorkProductArtifactFiles(spec);
      return {attachment:{status:attachment.status,mode:attachment.processingMode},read:read.output,
        files:generated.files.map(f=>({path:f.path,dataUrl:f.dataUrl})),html:generated.html};
    })()`);
    assert.equal(report.attachment.mode, 'ocr');
    assert.deepEqual(report.read.returned, ['page 2']);
    assert.match(report.read.content, /Invoice total 42 USD/i);
    assert.ok(!report.read.content.includes('Digital opening page'), 'range selection reads the scan only');
    const out = process.env.AGENTE_INGEST_OUTPUT || root;
    fs.mkdirSync(out, { recursive: true });
    for (const file of report.files) fs.writeFileSync(path.join(out, path.basename(file.path)), Buffer.from(file.dataUrl.split(',')[1], 'base64'));
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(report.html)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    win.webContents.invalidate();
    const preview = await Promise.race([win.webContents.capturePage(), new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Artifact preview capture timed out')), 10_000))]);
    fs.writeFileSync(path.join(out, 'invoice-preview.png'), preview.toPNG());
    console.log(JSON.stringify({ status: 'passed', realOcr: true, indexedPage: 2, files: report.files.map((file: { path: string }) => file.path), output: out }));
  } finally { win.destroy(); }
}

run().then(() => app.quit(), (error) => { console.error(error); app.exit(1); });
