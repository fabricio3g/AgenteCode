import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPreviewableUrl } from '../../main/link-preview.ts';

describe('link preview URL validation', () => {
  it('allows public HTTPS/HTTP URLs and local dev loopback hosts', () => {
    assert.equal(isPreviewableUrl('https://github.com/anomalyco/opencode'), true);
    assert.equal(isPreviewableUrl('http://localhost:5173/dashboard'), true);
    assert.equal(isPreviewableUrl('http://127.0.0.1:3000'), true);
  });

  it('blocks private LAN, cloud metadata, credentials, and non-HTTP schemes', () => {
    assert.equal(isPreviewableUrl('http://169.254.169.254/latest/meta-data'), false);
    assert.equal(isPreviewableUrl('http://192.168.1.10'), false);
    assert.equal(isPreviewableUrl('http://10.0.0.1'), false);
    assert.equal(isPreviewableUrl('https://user:pass@example.com'), false);
    assert.equal(isPreviewableUrl('file:///etc/passwd'), false);
    assert.equal(isPreviewableUrl('javascript:alert(1)'), false);
  });
});
