<svelte:options runes={true} />

<!-- The one footer every setup step uses. It starts on the content's left
     edge like every modal footer: the primary action first, Back beside it,
     and an optional quiet "skip" (or a key hint) hard right. -->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ArrowLeft } from '$lib/icons';
  import { Button } from '$lib/components/ui';

  let {
    onback,
    skipLabel,
    onskip,
    primaryLabel,
    primaryDisabled = false,
    primaryLoading = false,
    onprimary,
    hint
  }: {
    onback?: () => void;
    skipLabel?: string;
    onskip?: () => void;
    primaryLabel: string;
    primaryDisabled?: boolean;
    primaryLoading?: boolean;
    onprimary: () => void;
    /** A key hint for the right edge, when there is nothing to skip. */
    hint?: string;
  } = $props();
</script>

<footer class="setup-footer">
  <Button disabled={primaryDisabled} loading={primaryLoading} onclick={onprimary}>{primaryLabel}</Button>
  {#if onback}
    <Button variant="ghost" onclick={onback}><ArrowLeft /> {$t('onboarding.back')}</Button>
  {/if}
  <span class="flex-1"></span>
  {#if onskip}
    <Button variant="ghost" onclick={onskip}>{skipLabel ?? $t('onboarding.skip')}</Button>
  {:else if hint}
    <span class="setup-hint">{hint}</span>
  {/if}
</footer>

<style>
  /* No rule above it: the sheet's own edge closes the step. */
  .setup-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem var(--setup-gutter, 1.75rem) 1.5rem;
  }
  .setup-hint {
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
</style>
