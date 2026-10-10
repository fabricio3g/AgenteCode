import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { buildHandoffBundle, checkHandoffPages, checkHandoffText, deliverToProject, slugify } from '../../main/design/handoff.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'design-handoff-'));

/** A workspace with a page, an asset, a variant and a versions folder that must never travel. */
function workspace() {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Hi</title>');
  fs.writeFileSync(path.join(root, 'tokens.css'), ':root { --ink: #111; }');
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'logo.svg'), '<svg></svg>');
  fs.mkdirSync(path.join(root, 'variants', 'bold'), { recursive: true });
  fs.writeFileSync(path.join(root, 'variants', 'bold', 'index.html'), '<p>bold</p>');
  fs.mkdirSync(path.join(root, '.versions', '0001', 'files'), { recursive: true });
  fs.writeFileSync(path.join(root, '.versions', '0001', 'files', 'index.html'), 'old');
  return root;
}

test('slugify makes a folder-safe name and falls back to "design"', () => {
  assert.equal(slugify('Pricing page!'), 'pricing-page');
  assert.equal(slugify('  Crème brûlée  '), 'creme-brulee');
  assert.equal(slugify(''), 'design');
  assert.equal(slugify(undefined), 'design');
  assert.ok(slugify('x'.repeat(200)).length <= 48);
});

test('checkHandoffText rejects empty and oversized documents', () => {
  assert.equal(checkHandoffText('# Doc'), '# Doc');
  assert.throws(() => checkHandoffText('  '), /no handoff document/);
  assert.throws(() => checkHandoffText('x'.repeat(512 * 1024 + 1)), /too large/);
});

test('checkHandoffPages makes names safe and unique, and caps the count and size', () => {
  const pages = checkHandoffPages([
    { name: 'index.html', html: '<p>a</p>' },
    { name: 'variants/bold/index.html', html: '<p>b</p>' },
    { name: 'index.html', html: '<p>c</p>' }
  ]);
  assert.deepEqual(pages.map((page) => page.name), ['index.html', 'bold.html', 'index-2.html']);
  assert.throws(() => checkHandoffPages('nope'), /must be a list/);
  assert.throws(() => checkHandoffPages([{ name: 'a.html', html: '   ' }]), /no HTML/);
  assert.throws(() => checkHandoffPages(Array.from({ length: 41 }, () => ({ name: 'a.html', html: '<p>' }))), /at most 40/);
});

test('deliverToProject copies the design into .agente/designs and never overwrites', () => {
  const root = workspace();
  const project = tmp();
  const first = deliverToProject(root, project, 'Pricing', '# Pricing — handoff\n');
  assert.equal(first.slug, 'pricing');
  assert.equal(first.files, 4, 'versions are not copied');
  assert.equal(fs.readFileSync(path.join(project, '.agente', 'designs', 'pricing', 'HANDOFF.md'), 'utf8'), '# Pricing — handoff\n');
  assert.equal(fs.readFileSync(path.join(project, '.agente', 'designs', 'pricing', 'assets', 'logo.svg'), 'utf8'), '<svg></svg>');
  assert.equal(fs.existsSync(path.join(project, '.agente', 'designs', 'pricing', '.versions')), false);

  const second = deliverToProject(root, project, 'Pricing', 'again');
  assert.equal(second.slug, 'pricing-2');
  assert.equal(fs.readFileSync(path.join(project, '.agente', 'designs', 'pricing', 'HANDOFF.md'), 'utf8'), '# Pricing — handoff\n');
  const third = deliverToProject(root, project, 'Pricing', 'again');
  assert.equal(third.slug, 'pricing-3');
});

test('deliverToProject refuses a relative, missing or non-folder project and symlinked design folders', () => {
  const root = workspace();
  assert.throws(() => deliverToProject(root, 'relative/project', 'X', 'doc'), /Choose a project folder/);
  assert.throws(() => deliverToProject(root, path.join(tmp(), 'missing'), 'X', 'doc'), /does not exist/);
  const project = tmp();
  const elsewhere = tmp();
  fs.symlinkSync(elsewhere, path.join(project, '.agente'));
  assert.throws(() => deliverToProject(root, project, 'X', 'doc'), /not a plain folder/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('buildHandoffBundle zips the workspace, the handoff and the single-file pages', async () => {
  const root = workspace();
  const buffer = await buildHandoffBundle(root, '# Doc', [{ name: 'index.html', html: '<html>inlined</html>' }]);
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  assert.deepEqual(names, ['HANDOFF.md', 'assets/logo.svg', 'index.html', 'single-file/index.html', 'tokens.css', 'variants/bold/index.html']);
  assert.equal(await zip.file('HANDOFF.md').async('string'), '# Doc');
  assert.equal(await zip.file('single-file/index.html').async('string'), '<html>inlined</html>');
});
