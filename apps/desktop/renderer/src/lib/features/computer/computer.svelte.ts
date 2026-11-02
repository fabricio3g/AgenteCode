import type { ComputerState, ComputerSpace } from '$shared/computer';
import { EMPTY_COMPUTER_STATE } from '$shared/computer';
import { invoke, listen, isElectron } from '$lib/services/bridge';
import { appStore } from '$lib/stores/app.svelte';
import { codeStore } from '$lib/features/code/code.svelte';
import { createId } from '$lib/utils/id';
import { toastStore } from '$lib/stores/toast.svelte';

export const computerStore = $state({ state: { ...EMPTY_COMPUTER_STATE } as ComputerState, available: false, owned: false });
export async function controlComputer(action: 'takeover' | 'resume' | 'end') {
  try { await invoke('computer_control', { action }); }
  catch (error) { toastStore.error(error instanceof Error ? error.message : String(error)); }
}
export async function startComputerUseEvents(): Promise<() => void> {
  if (!isElectron()) return () => {};
  let disposed = false;
  let continuing = false;
  let resumeEpoch = 0;
  const offState = await listen<ComputerState>('computer_state', state => {
    computerStore.state = state; computerStore.owned = true;
    if (state.phase !== 'preparing') resumeEpoch++;
    if (state.phase === 'paused' && state.space === 'home' && state.chatId) appStore.stopStreaming(state.chatId);
  });
  const offResume = await listen<{ chatId: string; space: ComputerSpace }>('computer_resume', event => {
    if (continuing || !appStore.findChat(event.chatId)) return;
    continuing = true;
    const epoch = resumeEpoch;
    void (async () => {
      // Main has settled the native lease/runtime turn. Let its final UI event
      // settle too, without consuming this chat's draft or pending attachments.
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (disposed || epoch !== resumeEpoch || computerStore.state.phase !== 'preparing' || computerStore.state.chatId !== event.chatId) return;
        const running = event.space === 'code' ? codeStore.runFor(event.chatId)?.running : appStore.isChatGenerating(event.chatId);
        if (!running) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (disposed || epoch !== resumeEpoch) return;
      if (!ready) throw new Error('The previous turn is still stopping. Resume again once it has stopped.');
      const prompt = 'Continue the computer task from the current screen. Take a fresh computer_observe before acting.';
      if (event.space === 'code') await codeStore.send(event.chatId, prompt);
      else await appStore.sendCurrentMessage({ chatId: event.chatId, queuedPrompt: { id: createId('computer-resume'), content: prompt, attachments: [] } });
    })().catch(error => {
      toastStore.error(error instanceof Error ? error.message : String(error));
      void controlComputer('end');
    }).finally(() => { continuing = false; });
  });
  try {
    const initial = await invoke<{ available: boolean; owned: boolean; state: ComputerState }>('computer_status');
    if (!disposed) Object.assign(computerStore, initial);
  } catch { /* Older runtimes keep the computer entry unavailable. */ }
  return () => { disposed = true; offState(); offResume(); };
}
