import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
import type { ActiveGenerationRun } from '$lib/stores/app-store-types';

function fakeRun(): ActiveGenerationRun {
  return {
    controller: new AbortController(),
    messageId: 'msg-1',
    backendMode: 'api',
    mode: 'chat',
    startedAt: Date.now()
  };
}

describe('stopStreaming teardown', () => {
  beforeEach(() => {
    appStore.activeRunsByChat = {};
    browserPanelStore.agentDriving = false;
  });

  it('clears the agent-driving badge when an active run is aborted', () => {
    // The Home agent loop only reset this on normal exit; aborting left the
    // "Agent" badge stuck on the browser panel.
    browserPanelStore.agentDriving = true;
    appStore.activeRunsByChat = { 'chat-1': fakeRun() };

    appStore.stopStreaming('chat-1');

    expect(browserPanelStore.agentDriving).toBe(false);
    expect(appStore.activeRunsByChat['chat-1']).toBeUndefined();
  });

  it('clears a stuck badge even when no run is registered', () => {
    browserPanelStore.agentDriving = true;

    appStore.stopStreaming('chat-1');

    expect(browserPanelStore.agentDriving).toBe(false);
  });
});
