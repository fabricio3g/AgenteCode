<svelte:options runes={true} />

<script lang="ts">
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { Check, Target, X } from 'lucide-svelte';
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Button, Dialog } from '$lib/components/ui';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';

  type Goal = { objective: string; status: 'active' | 'completed' };
  let { sessionId, ensureSession, running = false }: { sessionId?: string; ensureSession: () => string; running?: boolean } = $props();
  let goal = $state<Goal | null>(null);
  let open = $state(false);
  let objective = $state('');
  let busy = $state(false);
  let confirming = $state(false);
  let editor = $state<HTMLTextAreaElement>();
  let goalButton = $state<HTMLButtonElement>();
  let returnFocus: HTMLElement | null = null;
  let request = 0;
  let previousSession: string | undefined;
  let sessionSeen = false;

  async function refresh(id: string | undefined) {
    const current = ++request;
    if (!id) { goal = null; return; }
    try {
      const value = await invoke<Goal | null>('agente_goal_get', { sessionId: id });
      if (current === request) goal = value;
    } catch (error) {
      if (current === request) toastStore.error(String(error));
    }
  }
  $effect(() => {
    const id = sessionId;
    if (sessionSeen && id !== previousSession) open = false;
    previousSession = id;
    sessionSeen = true;
    if (!running) void refresh(id);
  });

  export async function edit() {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = sessionId;
    await refresh(id);
    if (id !== sessionId) return;
    objective = goal?.objective ?? '';
    open = true;
    await tick();
    editor?.focus();
  }

  async function cancelEdit() {
    open = false;
    await tick();
    (returnFocus?.isConnected ? returnFocus : goalButton)?.focus();
  }

  async function save(status: Goal['status']) {
    if (!objective.trim() || busy) return;
    busy = true;
    try {
      const id = sessionId ?? ensureSession();
      const saved = await invoke<Goal>('agente_goal_set', { sessionId: id, objective: objective.trim(), status });
      request += 1;
      goal = saved;
      open = false;
    } catch (error) { toastStore.error(String(error)); }
    finally { busy = false; }
  }

  async function clear() {
    if (!sessionId || busy) return;
    busy = true;
    try {
      await invoke('agente_goal_clear', { sessionId });
      request += 1;
      goal = null;
      open = false;
      confirming = false;
    } catch (error) { toastStore.error(String(error)); }
    finally { busy = false; }
  }
</script>

{#if open}
  <div class="goal-edit-row">
    <Target class="goal-edit-icon size-3.5 shrink-0" aria-hidden="true" />
    <UiTextarea variant="composer" class="goal-editor" bind:ref={editor} bind:value={objective} aria-label={$t('goal.title')} placeholder={$t('goal.placeholder')} rows={1} maxlength={16384} onkeydown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void cancelEdit(); }
      else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void save('active'); }
    }}></UiTextarea>
    {#if goal?.status === 'active'}
      <Button variant="ghost" size="xs" onclick={() => save('completed')} disabled={busy}>{$t('goal.complete')}</Button>
    {/if}
    <IconButton label={$t('goal.save')} size="xs" quiet disabled={busy || !objective.trim()} onclick={() => save('active')}><Check /></IconButton>
    <IconButton label={$t('goal.cancel')} size="xs" quiet disabled={busy} onclick={() => void cancelEdit()}><X /></IconButton>
  </div>
{:else if goal?.status === 'active'}
  <div class="goal-row">
    <Button variant="plain" bind:ref={goalButton} type="button" class="goal-main" onclick={edit} title={goal.objective}>
      <Target class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="goal-label">{goal.objective}</span>
      <span class="goal-status">{$t('goal.active')}</span>
    </Button>
    <Button variant="plain" type="button" class="goal-remove" aria-label={$t('goal.clear')} title={$t('goal.clear')} onclick={() => (confirming = true)}><X class="size-3.5" aria-hidden="true" /></Button>
  </div>
{/if}

{#if confirming}
  <Dialog title={$t('goal.clear')} description={$t('goal.confirmClear')} size="sm" onclose={() => (confirming = false)}>
    <p class="goal-confirm-objective">{goal?.objective}</p>
    {#snippet footer()}
      <div class="goal-actions">
        <Button variant="ghost" onclick={() => (confirming = false)}>{$t('goal.cancel')}</Button>
        <Button onclick={clear} disabled={busy}>{$t('goal.clear')}</Button>
      </div>
    {/snippet}
  </Dialog>
{/if}

<style>
  .goal-row { pointer-events:auto; display:flex; align-items:center; min-width:0; width:100%; padding:0.25rem 0.5rem; color:var(--muted-foreground); font-size:var(--text-xs); }
  :global(.goal-main) { display:flex; align-items:center; gap:0.5rem; min-width:0; flex:1; text-align:left; }
  :global(.goal-main):hover, :global(.goal-main):focus-visible, :global(.goal-remove):hover { color:var(--foreground); }
  :global(.goal-remove) { display:grid; place-items:center; padding:0.25rem; margin-left:0.25rem; }
  .goal-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .goal-status { flex:none; margin-left:auto; }
  .goal-edit-row { pointer-events:auto; display:flex; align-items:flex-start; gap:0.25rem; min-width:0; padding:0.25rem 0.5rem; color:var(--muted-foreground); }
  :global(.goal-edit-icon) { margin:0.3rem 0.25rem 0 0; }
  .goal-confirm-objective { padding:0.5rem 1.25rem; color:var(--muted-foreground); font-size:var(--text-sm); overflow-wrap:anywhere; }
  :global(.goal-editor) { display:block; flex:1; min-width:0; min-height:1.5rem; max-height:6rem; field-sizing:content; resize:none; padding:0.25rem 0; border:0; background:transparent; color:var(--foreground); font-size:var(--text-xs); line-height:1.4; outline:none; }
  .goal-actions { display:flex; flex-wrap:wrap; gap:0.5rem; }
</style>
