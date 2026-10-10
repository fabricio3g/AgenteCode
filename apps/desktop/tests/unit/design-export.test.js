import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExportHtml, exportFileName } from '../../main/design/workspace.ts';

test('exportFileName names a page after its file or its variant folder', () => {
  assert.equal(exportFileName('index.html'), 'index.html');
  assert.equal(exportFileName('pricing.html'), 'pricing.html');
  assert.equal(exportFileName('variants/bold/index.html'), 'bold.html');
  assert.equal(exportFileName('../weird name!.html'), 'weird-name.html');
  assert.equal(exportFileName(''), 'design.html');
});

test('checkExportHtml rejects empty and oversized documents', () => {
  assert.equal(checkExportHtml('<!doctype html>'), '<!doctype html>');
  assert.throws(() => checkExportHtml('   '), /Nothing to export/);
  assert.throws(() => checkExportHtml(undefined), /Nothing to export/);
  assert.throws(() => checkExportHtml('x'.repeat(8 * 1024 * 1024 + 1)), /too large/);
});
