<svelte:options runes={true} />

<!-- The one footer every setup step uses: back on the left, then an optional
     quiet "skip" and the primary action on the right. -->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ArrowLeft } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';

  let {
    onback,
    skipLabel,
    onskip,
    primaryLabel,
    primaryDisabled = false,
    primaryLoading = false,
    onprimary
  }: {
    onback?: () => void;
    skipLabel?: string;
    onskip?: () => void;
    primaryLabel: string;
    primaryDisabled?: boolean;
    primaryLoading?: boolean;
    onprimary: () => void;
  } = $props();
</script>

<footer class="setup-footer">
  {#if onback}
    <Button variant="ghost" onclick={onback}><ArrowLeft /> {$t('onboarding.back')}</Button>
  {/if}
  <span class="flex-1"></span>
  {#if onskip}
    <Button variant="ghost" onclick={onskip}>{skipLabel ?? $t('onboarding.skip')}</Button>
  {/if}
  <Button disabled={primaryDisabled} loading={primaryLoading} onclick={onprimary}>{primaryLabel}</Button>
</footer>

<style>
  .setup-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.875rem 1.5rem;
    border-top: 1px solid var(--border-subtle);
  }
</style>
