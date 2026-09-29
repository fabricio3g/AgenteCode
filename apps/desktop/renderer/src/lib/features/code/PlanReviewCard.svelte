<svelte:options runes={true} />

<!--
  The plan the agent presented (plan mode's present_plan), waiting for an
  answer: build it (switches to Build with approvals), ask for a different
  plan, or comment on it in the composer.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ClipboardList, MessageSquare, RefreshCw, Hammer } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { codeStore } from './code.svelte';
  import { acceptMessage, REDO_MESSAGE, type PresentedPlan } from './plan-review';

  let { chatId, plan }: { chatId: string; plan: PresentedPlan } = $props();

  let busy = $state(false);

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
    window.dispatchEvent(new CustomEvent('code-composer-draft', { detail: $t('code.plan.commentPrefix') }));
  }
</script>

<section class="plan-card" aria-label={$t('code.plan.title')}>
  <header class="flex items-center gap-2">
    <ClipboardList class="size-4 text-muted-foreground" />
    <p class="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{plan.title}</p>
    {#if plan.path}<span class="truncate font-mono text-[11px] text-muted-foreground">{plan.path}</span>{/if}
  </header>
  <div class="plan-body text-sm leading-relaxed text-foreground">
    <RichContent content={plan.body} />
  </div>
  <footer class="flex flex-wrap items-center gap-2">
    <Button size="sm" disabled={busy} onclick={() => void answer('supervised', acceptMessage(plan))}><Hammer /> {$t('code.plan.accept')}</Button>
    <Button size="sm" variant="outline" disabled={busy} onclick={() => void answer('plan', REDO_MESSAGE)}><RefreshCw /> {$t('code.plan.redo')}</Button>
    <Button size="sm" variant="ghost" disabled={busy} onclick={comment}><MessageSquare /> {$t('code.plan.comment')}</Button>
    <span class="ml-auto text-[11.5px] text-muted-foreground">{$t('code.plan.hint')}</span>
  </footer>
</section>

<style>
  .plan-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    border-radius: 0.875rem;
    border: 1px solid var(--border-hover);
    background: var(--card);
    padding: 0.875rem 1rem;
  }
  .plan-body {
    max-height: 26rem;
    overflow-y: auto;
    border-top: 1px solid var(--border-subtle);
    border-bottom: 1px solid var(--border-subtle);
    padding: 0.5rem 0;
  }
</style>
