<svelte:options runes={true} />

<!--
  A message-box style's own miniature for Settings → Appearance: the composer's
  real markup and classes (`ComposerShell`'s: shell, input row, footer tray,
  the real `SendButton`) under `data-composer-style`, so the scoped style
  rules in app.css draw it exactly as they draw the live one. Shrunk with
  `zoom`, `inert`: the tile is the button.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Plus, Zap } from '$lib/icons';
  import { Textarea } from '$lib/components/ui';
  import type { ComposerStyleId } from '$shared/appearance';
  import { isIntegratedComposerStyle } from '$shared/appearance';
  import SendButton from '$lib/features/shared/composer/SendButton.svelte';

  let { composerStyle }: { composerStyle: ComposerStyleId } = $props();

  const integrated = $derived(isIntegratedComposerStyle(composerStyle));
  const sendInFooter = $derived(composerStyle === 'pill' || composerStyle === 'card');
  const noop = () => {};
</script>

{#snippet tray()}
  <span class="preview-tray">
    <Plus class="size-4" />
    <span class="preview-chip"><Zap class="size-3.5" />Auto</span>
    <span class="preview-model">deepseek-v4</span>
  </span>
{/snippet}

{#snippet send()}
  <div class="composer-send-slot">
    <SendButton compact running={false} sendLabel={$t('chat.send')} stopLabel={$t('chat.stop')} onsend={noop} onstop={noop} />
  </div>
{/snippet}

<span class="composer-preview" data-composer-style={composerStyle} inert aria-hidden="true">
  <span class="composer-preview-page">
    <div class="composer-shell ui-composer">
      <div class="composer-body">
        <div class="composer-input-row" class:has-footer-send={sendInFooter}>
          {#if composerStyle === 'terminal'}<span class="composer-terminal-prompt">›</span>{/if}
          <Textarea variant="composer" class="composer-textarea w-full resize-none bg-transparent text-foreground outline-none" rows={1} tabindex={-1} readonly placeholder={$t('code.composerPlaceholder')} />
          {#if !sendInFooter}{@render send()}{/if}
        </div>
      </div>
      {#if integrated}
        <div class="composer-shell-footer" class:has-send={sendInFooter}>
          <div class="composer-tray is-integrated">{@render tray()}</div>
          {#if sendInFooter}{@render send()}{/if}
        </div>
      {/if}
    </div>
    {#if !integrated}
      <div class="composer-tray">{@render tray()}</div>
    {/if}
  </span>
</span>

<style>
  /* The tile's canvas: the conversation's own background, the composer on it
     at a real width, shrunk. */
  .composer-preview {
    display: flex;
    width: 100%;
    height: 4.75rem;
    align-items: center;
    overflow: hidden;
    padding: 0 0.625rem;
    background: var(--chat-bg, var(--background));
    pointer-events: none;
    user-select: none;
  }
  .composer-preview-page {
    display: block;
    width: calc(100% / 0.45);
    zoom: 0.45;
  }
  .preview-tray {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.25rem 0.375rem;
    color: var(--text-secondary);
  }
  .preview-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .preview-model {
    margin-left: auto;
    color: var(--foreground);
  }
</style>
