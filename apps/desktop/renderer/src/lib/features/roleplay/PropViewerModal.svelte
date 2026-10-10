<svelte:options runes={true} />

<!--
  Prop viewer: read a thing the scene handed you.

  Deliberately not the artifact viewer. That one is for work products — reports
  with manifests, spreadsheets with tabs — and it reads like a deliverable. This
  reads like the object itself: serif body, generous measure, nothing else on
  screen but the text and what you can do with it.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';

  import { t } from 'svelte-i18n';
  import { Button, Tooltip } from '$lib/components/ui';
  import { Copy, X } from 'lucide-svelte';
  import { BookMarked } from 'lucide-svelte';
  import { flyAndScale, motionFade } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { appStore } from '$lib/stores/app.svelte';
  import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
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

  // Shown and copied with macros resolved; keeping it to the journal stores the raw prop.
  const title = $derived(roleplayStore.displayText(prop.title, { messageId }));
  const body = $derived(roleplayStore.displayText(prop.body, { messageId }));

  const kept = $derived(
    !!appStore.currentChat?.roleplay?.journal?.some((entry) => entry.messageId === messageId && entry.title === prop.title)
  );

  async function copyBody() {
    await writeToClipboard(body);
    toastStore.info(copyText.actions.copied || 'Copied.', 2000);
  }

  function keep() {
    roleplayStore.addJournalEntry({
      kind: 'prop',
      title: prop.title,
      body: prop.body,
      messageId
    });
  }
</script>

<div
  class="ui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: onclose }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="ui-modal-surface max-w-xl prop-surface"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="min-w-0">
        <div class="ui-modal-title">{title}</div>
        <div class="text-xs text-muted-foreground">{prop.kind}</div>
      </div>
      <Tooltip label={copyText.actions.close} position="bottom"><UiIconButton label={copyText.actions.close} size="sm" type="button"  onclick={onclose} >
        <X class="size-4" />
      </UiIconButton></Tooltip>
    </div>

    <div class="ui-modal-body max-h-[58vh] overflow-y-auto">
      <div class="prop-body">{body}</div>
    </div>

    <div class="prop-actions">
      <Button variant="outline" size="sm" type="button" onclick={copyBody}>
        <Copy class="size-3.5" />
        <span>{$t('roleplay.prop.copy')}</span>
      </Button>
      <Button variant="outline" size="sm" type="button" disabled={kept} onclick={keep}>
        <BookMarked class="size-3.5" />
        <span>{kept ? $t('roleplay.prop.inJournal') : $t('roleplay.prop.keep')}</span>
      </Button>
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
