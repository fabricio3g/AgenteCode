import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFlows, setFlows } from '../../main/design/flows.ts';
import { addReference, addReferenceFile, removeReference } from '../../main/design/references.ts';
import { clampExportWidth, exportImageName, pdfBytes, pdfPageSize, pngBytes, PDF_MAX_HEIGHT_PX } from '../../main/design/export.ts';
import { ensureWorkspace, writeText } from '../../main/design/workspace.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-test-body')]);
let tmp;
let root;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-flows-'));
  root = ensureWorkspace(path.join(tmp, 'chat-1'));
  writeText(root, 'index.html', '<h1>home</h1>');
  writeText(root, 'pricing.html', '<h1>pricing</h1>');
  writeText(root, 'variants/bold/index.html', '<h1>bold</h1>');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('setFlows writes validated links to flows.json and readFlows reads them back', () => {
  const result = setFlows(root, [{ from: 'index.html', to: 'pricing.html' }, { from: 'index.html', to: 'pricing.html' }, { from: 'pricing.html', to: 'variants/bold/index.html' }]);
  assert.equal(result.path, 'flows.json');
  assert.equal(result.links.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'flows.json'), 'utf8')).links[0], { from: 'index.html', to: 'pricing.html' });
  assert.deepEqual(readFlows(root), result.links);
});

test('setFlows refuses a write with a missing page, a self-link or a non-list, and leaves the file as it was', () => {
  const before = fs.readFileSync(path.join(root, 'flows.json'), 'utf8');
  assert.throws(() => setFlows(root, [{ from: 'index.html', to: 'nope.html' }]), /Unknown page/);
  assert.throws(() => setFlows(root, [{ from: 'index.html', to: 'index.html' }]), /itself/);
  assert.throws(() => setFlows(root, [{ from: '../../etc/passwd', to: 'index.html' }]), /needs/);
  assert.throws(() => setFlows(root, 'index.html'), /list/);
  assert.equal(fs.readFileSync(path.join(root, 'flows.json'), 'utf8'), before);
});

test('readFlows drops links to pages that were deleted, without failing', () => {
  fs.writeFileSync(path.join(root, 'flows.json'), JSON.stringify({ links: [{ from: 'index.html', to: 'pricing.html' }, { from: 'index.html', to: 'gone.html' }] }));
  assert.deepEqual(readFlows(root), [{ from: 'index.html', to: 'pricing.html' }]);
  fs.writeFileSync(path.join(root, 'flows.json'), '{broken');
  assert.deepEqual(readFlows(root), []);
});

test('removeReference deletes one image directly inside references/ and nothing else', () => {
  const added = addReference(root, 'Hero Shot.png', PNG.toString('base64'));
  assert.equal(added.path, 'references/hero-shot.png');
  assert.throws(() => removeReference(root, 'index.html'), /references\//);
  assert.throws(() => removeReference(root, 'references/../index.html'), /references\//);
  assert.throws(() => removeReference(root, 'references/sub/x.png'), /references\//);
  assert.throws(() => removeReference(root, 'references/missing.png'), /No such image/);
  assert.equal(removeReference(root, added.path), added.path);
  assert.equal(fs.existsSync(path.join(root, added.path)), false);
  assert.ok(fs.existsSync(path.join(root, 'index.html')));
});

test('addReferenceFile reads a chosen file, by its bytes', () => {
  const good = path.join(tmp, 'My Pic.png');
  fs.writeFileSync(good, PNG);
  assert.equal(addReferenceFile(root, good).path, 'references/my-pic.png');
  const fake = path.join(tmp, 'fake.png');
  fs.writeFileSync(fake, '<svg/>');
  assert.throws(() => addReferenceFile(root, fake), /Only PNG/);
  assert.throws(() => addReferenceFile(root, tmp), /Choose an image file/);
});

test('export helpers name files, clamp widths and size the PDF page', () => {
  assert.equal(exportImageName('pricing.html', 'png', 390), 'pricing-390.png');
  assert.equal(exportImageName('variants/bold/index.html', 'pdf'), 'bold.pdf');
  assert.equal(clampExportWidth(100), 280);
  assert.equal(clampExportWidth(99999), 2560);
  assert.equal(clampExportWidth(undefined), 1440);
  assert.deepEqual(pdfPageSize(960, 1920), { width: 10, height: 20 });
  assert.equal(pdfPageSize(960, 1e9).height, PDF_MAX_HEIGHT_PX / 96);
  assert.equal(pdfPageSize(960, NaN).height, 200 / 96);
});

test('pngBytes and pdfBytes refuse bytes that are not what the name says', () => {
  assert.equal(pngBytes(PNG.toString('base64')).length, PNG.length);
  assert.throws(() => pngBytes('aGVsbG8='), /could not be rendered/);
  assert.throws(() => pngBytes(undefined), /could not be rendered/);
  assert.equal(pdfBytes(Buffer.from('%PDF-1.7 x')).length, 10);
  assert.throws(() => pdfBytes(Buffer.from('nope')), /could not be rendered/);
  assert.throws(() => pdfBytes('%PDF-'), /could not be rendered/);
});
