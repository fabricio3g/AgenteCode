<svelte:options runes={true} />

<!--
  One subagent, opened from the session column into the right dock: what it
  was asked, what it is doing right now, its answer as it streams and every
  tool call with its output. The live run's copy wins over the saved one, so
  the view follows a working child and still shows a finished one after the
  turn has settled.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Bot, Copy, ListChecks, Square, Telescope } from '$lib/icons';
  import type { ChatSession } from '$lib/types/chat';
  import { Button, IconButton } from '$lib/components/ui';
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { shortModel } from '$lib/utils/format';
  import { formatToolDuration, titleCaseToolName } from '$lib/utils/tool-ui';
  import { codeStore } from './code.svelte';
  import { spendCostLabel } from './accounting';
  import { childActivity, childElapsedMs, sessionChildren } from './subagent-row';
  import CodeStepRow from './CodeStepRow.svelte';
  import CodeErrorNotice from './CodeErrorNotice.svelte';

  let { chat, childId }: { chat: ChatSession; childId: string } = $props();

  const run = $derived(codeStore.runFor(chat.id));
  const child = $derived(sessionChildren(chat.messages, run?.children ?? []).find((item) => item.id === childId));
  const running = $derived(child?.status === 'running');
  const failed = $derived(child?.status === 'error');
  let stopped = $state(false);

  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });
  const elapsed = $derived(child ? childElapsedMs(child, now) : undefined);
  const Icon = $derived(child && /explore/i.test(child.kind) ? Telescope : child && /plan/i.test(child.kind) ? ListChecks : Bot);
  const errorDetail = $derived(failed && child ? child.summary || child.text : '');
  const reply = $derived(child && !(failed && child.text.trim() === errorDetail.trim()) ? child.text : '');

  async function stop() {
    if (!child) return;
    stopped = true;
    try { await invoke('agente_child_cancel', { runId: child.id }); }
    catch (error) { stopped = false; toastStore.error(String(error)); }
  }
  async function copyText() {
    try {
      if (!child || !await writeToClipboard(child.summary || child.text)) throw new Error('Could not copy the subagent text');
      toastStore.success($t('chat.copied'));
    } catch (error) { toastStore.error(String(error)); }
  }
</script>

<div class="pane-body subagent-view" data-subagent-view={childId}>
  {#if child}
    <header class="head">
      <span class="kind"><Icon class="size-3.5 shrink-0" />{titleCaseToolName(child.kind || 'subagent')}</span>
      {#if running && !stopped && !run?.stopping}
        <IconButton size="xs" variant="ghost" label={$t('code.stopSubagent')} onclick={stop}><Square class="size-3" /></IconButton>
      {/if}
    </header>
    {#if child.description}<p class="ask">{child.description}</p>{/if}

    <p class="status" class:text-error={failed}>
      {#if running}<TileMeter mode={stopped || run?.stopping ? 'stopped' : 'busy'} /><span class="ui-shimmer-text">{childActivity(child) ?? copy.status.working}</span>
      {:else}<span>{failed ? copy.tool.failed : copy.tool.done}</span>{/if}
      {#if elapsed !== undefined}<span>· {formatToolDuration(elapsed)}</span>{/if}
      {#if child.tools.length}<span>· {$t('code.subagent.tools', { values: { n: child.tools.length } })}</span>{/if}
      {#if child.model}<span title={child.model}>· {shortModel(child.model)}</span>{/if}
      {#if spendCostLabel(child.spend)}<span>· {spendCostLabel(child.spend)}</span>{/if}
    </p>

    {#if failed && errorDetail}<CodeErrorNotice detail={errorDetail} />{/if}

    {#if reply}
      <section>
        <h3 class="pane-heading">{$t('sessionHud.answer')}</h3>
        <div class="reply"><RichContent content={reply} status={failed ? 'error' : running ? 'streaming' : 'idle'} /></div>
        {#if !running}<Button variant="plain" size="xs" onclick={copyText}><Copy class="size-3" />{copy.actions.copy}</Button>{/if}
      </section>
    {/if}

    {#if child.tools.length}
      <section>
        <h3 class="pane-heading">{$t('sessionHud.tools')}<span class="pane-count">{child.tools.length}</span></h3>
        {#each child.tools as tool (tool.id)}
          <CodeStepRow step={{ id: tool.id, type: 'tool', label: tool.name, toolName: tool.name, status: tool.status, output: tool.output }} id={`subagent-view:${child.id}:${tool.id}`} />
        {/each}
      </section>
    {/if}

    {#if !failed && child.summary && !child.text.trimEnd().endsWith(child.summary.trim())}
      <section><RichContent content={child.summary} /></section>
    {/if}
  {:else}
    <p class="pane-empty">{$t('sessionHud.gone')}</p>
  {/if}
</div>

<style>
  .head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0 0.5rem; }
  .kind { display: inline-flex; align-items: center; gap: 0.5rem; color: var(--foreground); font-size: var(--text-sm); font-weight: 550; }
  .ask { margin: -0.75rem 0 0; padding: 0 0.5rem; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.5; }
  .status { display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; margin: -0.5rem 0 0; padding: 0 0.5rem; color: var(--muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .reply { padding: 0 0.5rem; font-size: var(--text-sm); }
</style>
