<svelte:options runes={true} />

<!--
  The plan the agent presented (plan mode's present_plan), in the right
  dock beside the conversation — the way the agent browser sits there. While
  it waits for an answer the footer offers the three the TUI does: build it
  (switches to Build with approvals), ask for a different plan, or comment
  on it in the composer. An answered plan stays readable, without actions.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { t } from 'svelte-i18n';
  import { ClipboardList, MessageSquare, RefreshCw, Hammer, X } from 'lucide-svelte';
  import { Button, Tooltip } from '$lib/components/ui';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { codeStore } from './code.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import { acceptMessage, isPlanWaiting, REDO_MESSAGE, type PresentedPlan } from './plan-review';

  let { chatId, plan, embedded = false }: { chatId: string; plan: PresentedPlan; embedded?: boolean } = $props();

  let busy = $state(false);

  const messages = $derived(appStore.chats.find((chat) => chat.id === chatId)?.messages ?? []);
  const waiting = $derived(isPlanWaiting(messages, plan) && !codeStore.runFor(chatId)?.running);

  async function answer(mode: 'supervised' | 'plan', text: string) {
    busy = true;
    try {
      await codeStore.setMode(chatId, mode);
      await codeStore.send(chatId, text);
    } finally {
      busy = false;
    }
  }

  function comment() {
    window.dispatchEvent(new CustomEvent('code-composer-draft', { detail: { chatId, text: $t('code.plan.commentPrefix') } }));
  }
</script>

<aside class="flex min-h-0 flex-1 flex-col" aria-label={$t('code.plan.title')}>
  {#if !embedded}<header class="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] pl-4 pr-2">
    <ClipboardList class="size-4 shrink-0 text-muted-foreground" />
    <p class="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={plan.path || plan.title}>{plan.title}</p>
    <Tooltip label={$t('codeWs.close')} position="bottom"><IconButton label={$t('codeWs.close')} variant="ghost" size="sm" onclick={() => codeWorkspace.closePlan()} ><X /></IconButton></Tooltip>
  </header>{/if}
  <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed text-foreground">
    {#if plan.path}<p class="mb-3 truncate text-xs text-muted-foreground" title={plan.path}>{plan.path}</p>{/if}
    <RichContent content={plan.body} />
  </div>
  {#if waiting}
    <footer class="flex shrink-0 flex-col gap-2 border-t border-[var(--border-subtle)] px-5 py-3">
      <div class="flex flex-wrap items-center gap-2" title={$t('code.plan.hint')}>
        <Button size="sm" disabled={busy} onclick={() => void answer('supervised', acceptMessage(plan))}><Hammer /> {$t('code.plan.accept')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onclick={() => void answer('plan', REDO_MESSAGE)}><RefreshCw /> {$t('code.plan.redo')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onclick={comment}><MessageSquare /> {$t('code.plan.comment')}</Button>
      </div>
    </footer>
  {/if}
</aside>
