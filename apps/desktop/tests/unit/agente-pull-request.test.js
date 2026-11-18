import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rollupChecks, webUrl } from '../../main/agente/pull-request.ts';

describe('the branch as a pull request', () => {
  it('turns any origin spelling into its web address', () => {
    assert.equal(webUrl('git@github.com:acme/app.git'), 'https://github.com/acme/app');
    assert.equal(webUrl('ssh://git@github.com/acme/app.git'), 'https://github.com/acme/app');
    assert.equal(webUrl('https://token@github.com/acme/app.git'), 'https://github.com/acme/app');
    assert.equal(webUrl('https://gitlab.com/group/sub/app/'), 'https://gitlab.com/group/sub/app');
    assert.equal(webUrl('/srv/repos/app.git'), null);
  });

  it('rolls checks into one state, failure first', () => {
    assert.equal(rollupChecks(undefined), 'none');
    assert.equal(rollupChecks([]), 'none');
    assert.equal(rollupChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'pass');
    assert.equal(rollupChecks([{ status: 'IN_PROGRESS', conclusion: '' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'pending');
    assert.equal(rollupChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'fail');
    // Commit statuses carry `state` instead of status/conclusion.
    assert.equal(rollupChecks([{ state: 'PENDING' }]), 'pending');
    assert.equal(rollupChecks([{ state: 'SUCCESS' }]), 'pass');
  });
});
