import { describe, it } from 'node:test';
import assert from 'node:assert';

import { SNAPSHOT_ELEMENT_LIMIT, SNAPSHOT_SCRIPT, SNAPSHOT_TEXT_LIMIT } from '../../shared/browser/snapshot.ts';

// The main process and the browser extension both import shared/browser/* directly.

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
