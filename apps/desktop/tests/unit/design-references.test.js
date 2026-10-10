import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addReference, readReferenceImage, referenceFileNames, referenceStemOf, saveReferenceScreenshot, sniffImage } from '../../main/design/references.ts';
import { createSystemFromFiles, getSystem, listSystems } from '../../main/design/systems.ts';
import { ensureWorkspace, writeText } from '../../main/design/workspace.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-test-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-test-body')]);
const GIF = Buffer.from('GIF89a-test-body');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.from([0, 0, 0, 0])]);
const b64 = (bytes) => bytes.toString('base64');

let tmp;
let root;
let systemsRoot;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-references-'));
  root = ensureWorkspace(path.join(tmp, 'chat-1'));
  systemsRoot = path.join(tmp, 'design-systems');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('sniffImage reads the image type from the bytes, never the name', () => {
  assert.equal(sniffImage(PNG).mimeType, 'image/png');
  assert.equal(sniffImage(JPEG).ext, 'jpg');
  assert.equal(sniffImage(GIF).mimeType, 'image/gif');
  assert.equal(sniffImage(WEBP).mimeType, 'image/webp');
  assert.equal(sniffImage(AVIF).mimeType, 'image/avif');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'SVG is not a reference');
  assert.equal(sniffImage(Buffer.from('%PDF-1.7')), null);
});

test('referenceStemOf makes a safe file stem from any user file name', () => {
  assert.equal(referenceStemOf('Hero Shot (final).PNG'), 'hero-shot-final');
  assert.equal(referenceStemOf('../../etc/x y.jpg'), 'x-y');
  assert.equal(referenceStemOf(undefined), 'reference');
});

test('addReference keeps a copy in references/, named by the user and typed by its bytes', () => {
  const first = addReference(root, 'Hero Shot.png', b64(PNG));
  assert.deepEqual(first, { path: 'references/hero-shot.png', existed: false });
  assert.deepEqual(fs.readFileSync(path.join(root, 'references', 'hero-shot.png')), PNG);

  assert.deepEqual(addReference(root, 'copy of hero.png', `data:image/png;base64,${b64(PNG)}`), { path: 'references/hero-shot.png', existed: true }, 'the same bytes are kept once');
  assert.deepEqual(addReference(root, 'Hero Shot.png', b64(Buffer.concat([PNG, Buffer.from('v2')]))), { path: 'references/hero-shot-2.png', existed: false }, 'a new picture under a taken name is numbered');
  assert.deepEqual(addReference(root, 'photo.png', b64(JPEG)), { path: 'references/photo.jpg', existed: false }, 'a JPEG named .png is stored as a JPEG');
  assert.deepEqual(referenceFileNames(root).sort(), ['hero-shot-2.png', 'hero-shot.png', 'photo.jpg']);
});

test('addReference refuses what is not a picture, and anything too large', () => {
  assert.throws(() => addReference(root, 'notes.png', b64(Buffer.from('plain text'))), /Only PNG, JPEG, WebP, GIF and AVIF/);
  assert.throws(() => addReference(root, 'empty.png', ''), /No image data/);
  const huge = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]);
  assert.throws(() => addReference(root, 'huge.png', b64(huge)), /too large/);
});

test('readReferenceImage returns a picture from references/ or assets/, and nothing else', () => {
  const image = readReferenceImage(root, 'references/hero-shot.png');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.bytes, PNG.length);
  assert.equal(image.data, b64(PNG));
  assert.equal(readReferenceImage(root, './references/photo.jpg').mimeType, 'image/jpeg');

  writeText(root, 'index.html', '<!doctype html>');
  fs.writeFileSync(path.join(root, 'references', 'fake.png'), 'not really a picture');
  fs.writeFileSync(path.join(root, 'references', 'modern.avif'), AVIF);
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'logo.gif'), GIF);
  assert.equal(readReferenceImage(root, 'assets/logo.gif').mimeType, 'image/gif');

  assert.throws(() => readReferenceImage(root, 'index.html'), /references\/ or assets\//);
  assert.throws(() => readReferenceImage(root, '../outside.png'), /references\/ or assets\//, 'only the two folders are readable');
  assert.throws(() => readReferenceImage(root, 'references/../../outside.png'), /leave the design workspace/, 'a traversal inside the folder is caught by the jail');
  assert.throws(() => readReferenceImage(root, '.versions/0001/meta.json'), /managed by the app|references\/ or assets\//);
  assert.throws(() => readReferenceImage(root, 'references/fake.png'), /not a PNG, JPEG, WebP or GIF/);
  assert.throws(() => readReferenceImage(root, 'references/modern.avif'), /not a PNG, JPEG, WebP or GIF/);
  assert.throws(() => readReferenceImage(root, 'references/missing.png'), /No such image/);
});

test('readReferenceImage will not follow a symbolic link out of the workspace', () => {
  const secret = path.join(tmp, 'secret.png');
  fs.writeFileSync(secret, PNG);
  fs.symlinkSync(secret, path.join(root, 'references', 'linked.png'));
  assert.throws(() => readReferenceImage(root, 'references/linked.png'), /Symbolic links/);
});

test('saveReferenceScreenshot numbers each host’s pictures and never overwrites one', () => {
  assert.equal(saveReferenceScreenshot(root, 'stripe-com', PNG), 'references/stripe-com-1.png');
  assert.equal(saveReferenceScreenshot(root, 'stripe-com', JPEG), 'references/stripe-com-2.png');
  assert.deepEqual(fs.readFileSync(path.join(root, 'references', 'stripe-com-1.png')), PNG);
});

test('createSystemFromFiles saves tokens.css and DESIGN.md as a system, and only those', () => {
  const summary = createSystemFromFiles(systemsRoot, {
    name: 'Example landing',
    description: 'Read from https://example.com by design_reference.',
    files: { 'tokens.css': ':root { --bg: #ffffff; }\n', 'DESIGN.md': '# Reference\n' }
  });
  assert.equal(summary.name, 'Example landing');
  assert.equal(summary.origin, 'design');
  assert.equal(summary.hasTokens, true);
  assert.equal(summary.hasSpecimen, false);
  const detail = getSystem(systemsRoot, summary.id);
  assert.equal(detail.files.files['tokens.css'], ':root { --bg: #ffffff; }\n');
  assert.ok(listSystems(systemsRoot).some((system) => system.id === summary.id));

  assert.throws(() => createSystemFromFiles(systemsRoot, { name: 'Bad', description: '', files: { 'index.html': '<p>x</p>' } }), /tokens.css and DESIGN.md/);
  assert.throws(() => createSystemFromFiles(systemsRoot, { name: 'Bad', description: '', files: { 'components.html': '<p>x</p>' } }), /tokens.css and DESIGN.md/);
  assert.throws(() => createSystemFromFiles(systemsRoot, { name: 'Bad', description: '', files: {} }), /tokens.css and DESIGN.md/);
  assert.throws(() => createSystemFromFiles(systemsRoot, { name: '  ', description: '', files: { 'tokens.css': ':root{}' } }), /A name is required/);
});
