import { describe, it } from 'node:test';
import assert from 'node:assert';

import * as sharedFormat from '../../shared/browser/format.ts';
import { describeLoadError, formatConsole, formatSnapshot, isLocalUrl } from '../../main/browser-format.ts';
import { SNAPSHOT_ELEMENT_LIMIT, SNAPSHOT_SCRIPT, SNAPSHOT_TEXT_LIMIT } from '../../shared/browser/snapshot.ts';

// The browser extension imports shared/browser/* directly; these tests pin down
// that the panel's re-export and the shared modules are the same code, so the
// two snapshots (panel and extension) cannot drift apart.

const snapshot = {
  url: 'http://localhost:5173/',
  title: 'Demo',
  elements: ['e1 button "Save"', 'e2 textbox "Email" value=""'],
  text: 'Welcome',
  scrollY: 40,
  scrollHeight: 2000,
  viewportHeight: 800,
  truncated: false,
  newErrors: 2
};

describe('shared browser text', () => {
  it('is the exact code the main process re-exports', () => {
    assert.strictEqual(formatSnapshot, sharedFormat.formatSnapshot);
    assert.strictEqual(formatConsole, sharedFormat.formatConsole);
    assert.strictEqual(describeLoadError, sharedFormat.describeLoadError);
    assert.strictEqual(isLocalUrl, sharedFormat.isLocalUrl);
  });

  it('formats the same snapshot through both import paths', () => {
    assert.strictEqual(formatSnapshot(snapshot), sharedFormat.formatSnapshot(snapshot));
    assert.strictEqual(formatConsole([]), sharedFormat.formatConsole([]));
    assert.strictEqual(
      formatConsole([{ level: 'error', source: 'network', text: 'HTTP 404 /api' }]),
      sharedFormat.formatConsole([{ level: 'error', source: 'network', text: 'HTTP 404 /api' }])
    );
  });

  it('agrees on local URLs through both import paths', () => {
    for (const url of ['http://localhost:5173', 'http://127.0.0.1:8080/x', 'https://example.com', 'not a url']) {
      assert.strictEqual(isLocalUrl(url), sharedFormat.isLocalUrl(url), url);
    }
  });
});

describe('shared browser snapshot script', () => {
  it('is a non-empty, page-ready script that tags elements with data-agent-ref', () => {
    assert.strictEqual(typeof SNAPSHOT_SCRIPT, 'string');
    assert.ok(SNAPSHOT_SCRIPT.length > 0);
    assert.ok(SNAPSHOT_SCRIPT.includes('data-agent-ref'));
    // One self-contained expression: it is stringified and evaluated in the page.
    assert.ok(SNAPSHOT_SCRIPT.startsWith('(() => {') && SNAPSHOT_SCRIPT.endsWith('})()'));
    // The limits are interpolated; an unresolved placeholder would break the page.
    assert.ok(!SNAPSHOT_SCRIPT.includes('${'));
    assert.ok(SNAPSHOT_SCRIPT.includes(`const LIMIT = ${SNAPSHOT_ELEMENT_LIMIT};`));
    assert.ok(SNAPSHOT_SCRIPT.includes(`.slice(0, ${SNAPSHOT_TEXT_LIMIT})`));
  });
});
