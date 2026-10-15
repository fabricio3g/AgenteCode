<script lang="ts">
  import { SearchField, Toolbar } from '$lib/components/ui';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  let { query = $bindable(''), placeholder = '', children }: { query?: string; placeholder?: string; children?: Snippet } = $props();
</script>
{#if placeholder || children}
  <Toolbar class="mb-3.5">
    {#if placeholder}<SearchField bind:value={query} {placeholder} clearLabel={$t('roleplay.library.clearSearch')} class="basis-40" />{:else}<span class="flex-1"></span>{/if}
    {@render children?.()}
  </Toolbar>
{/if}
