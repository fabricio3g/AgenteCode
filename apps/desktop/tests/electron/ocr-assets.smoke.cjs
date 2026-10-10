/** Packaged renderer OCR with all HTTP(S) blocked; build renderer first.
 * Run from apps/desktop: electron --no-sandbox tests/electron/ocr-assets.smoke.cjs
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const sharp = require('sharp');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'agente-ocr-assets-')));
const root = path.resolve('renderer/dist');
const page = path.join(root, '.ocr-smoke.html');
async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const chunk = fs.readdirSync(path.join(root, 'assets')).find((name) => /^ocr-[^/]+\.js$/.test(name));
  assert.ok(chunk, 'OCR chunk must be in the production build');
  assert.ok(fs.existsSync(path.join(root, 'assets', 'ocr', 'eng.traineddata.gz')), 'language filename must match Tesseract');
  const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="170"><rect width="900" height="170" fill="white"/><text x="50" y="110" font-family="DejaVu Sans" font-size="60">Invoice total 42 USD</text></svg>')).png().toBuffer();
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div></body></html>');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadFile(page);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const {extractFileContent} = await import(${JSON.stringify(pathToFileURL(path.join(root, 'assets', chunk)).href)});
      const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), c=>c.charCodeAt(0));
      return extractFileContent(new File([bytes],'invoice.png',{type:'image/png'}));
    })()`);
    assert.equal(result.method, 'ocr');
    assert.match(result.text, /Invoice total 42 USD/i);
    console.log(JSON.stringify({ status: 'passed', packagedOcr: true, offline: true, text: result.text }));
  } finally { win.destroy(); fs.rmSync(page, { force: true }); }
}
run().then(() => app.quit(), (error) => { console.error(error); fs.rmSync(page, { force: true }); app.exit(1); });
