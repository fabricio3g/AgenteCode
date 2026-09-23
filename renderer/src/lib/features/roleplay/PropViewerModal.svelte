<svelte:options runes={true} />

<!--
  Prop viewer: read a thing the scene handed you.

  Deliberately not the artifact viewer. That one is for work products — reports
  with manifests, spreadsheets with tabs — and it reads like a deliverable. This
  reads like the object itself: serif body, generous measure, nothing else on
  screen but the text and what you can do with it.
-->

<script lang="ts">
  import { Copy, X } from 'lucide-svelte';
  import { BookMarked } from 'lucide-svelte';
  import { flyAndScale, motionFade } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy as copyText } from '$lib/copy';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import type { RoleplayProp } from './roleplay-props';

  interface Props {
    prop: RoleplayProp;
    messageId?: string | null;
    onclose: () => void;
  }

  let { prop, messageId = null, onclose }: Props = $props();

  const kept = $derived(
    !!appStore.currentChat?.roleplay?.journal?.some((entry) => entry.messageId === messageId && entry.title === prop.title)
  );

  async function copyBody() {
    await writeToClipboard(prop.body);
    toastStore.info(copyText.actions.copied || 'Copied.', 2000);
  }

  function keep() {
    appStore.addRoleplayJournalEntry({
      kind: 'prop',
      title: prop.title,
      body: prop.body,
      messageId
    });
  }
</script>

<div
  class="aui-modal-backdrop z-[61]"
  role="presentation"
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="aui-modal-surface max-w-xl prop-surface"
    role="dialog"
    aria-modal="true"
    aria-label={prop.title}
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="aui-modal-header">
      <div class="min-w-0">
        <div class="aui-modal-title">{prop.title}</div>
        <div class="text-xs text-muted-foreground">{prop.kind}</div>
      </div>
      <button type="button" class="aui-icon-button size-8" onclick={onclose} aria-label={copyText.actions.close}>
        <X class="size-4" />
      </button>
    </div>

    <div class="aui-modal-body max-h-[58vh] overflow-y-auto">
      <div class="prop-body">{prop.body}</div>
    </div>

    <div class="prop-actions">
      <button type="button" class="aui-btn aui-btn-ghost" onclick={copyBody}>
        <Copy class="size-3.5" />
        <span>Copy</span>
      </button>
      <button type="button" class="aui-btn aui-btn-ghost" disabled={kept} onclick={keep}>
        <BookMarked class="size-3.5" />
        <span>{kept ? 'In journal' : 'Keep in journal'}</span>
      </button>
    </div>
  </div>
</div>

<style>
  .prop-surface {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* Serif, so it reads as a letter rather than a report. */
  .prop-body {
    color: var(--foreground);
    font-family: var(--font-serif);
    font-size: 0.9375rem;
    line-height: 1.7;
    white-space: pre-wrap;
  }

  .prop-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--border-subtle);
  }
</style>
