<svelte:options runes={true} />

<!--
  Extension toggles for the Code agent, in the shared Menu (Escape, outside
  click and keyboard all work). Items are checkboxes, so toggling one keeps
  the menu open.
-->

<script lang="ts">
  import { Check, Puzzle } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import Menu from '$lib/components/ui/Menu.svelte';
  import { listAgenteExtensions, setAgenteExtensionEnabled, type AgenteExtensionInfo } from './code-ipc';

  let open = $state(false);
  let extensions = $state<AgenteExtensionInfo[]>([]);

  $effect(() => {
    if (open) void listAgenteExtensions().then((list) => (extensions = list), () => (extensions = []));
  });

  async function toggle(extension: AgenteExtensionInfo) {
    const next = !extension.enabled;
    extension.enabled = next;
    extensions = [...extensions];
    const result = await setAgenteExtensionEnabled(extension.id, next).catch(() => ({ ok: false }));
    if (!result.ok) {
      extension.enabled = !next;
      extensions = [...extensions];
    }
  }
</script>

<Menu bind:open placement="bottom-end" minWidth="18rem" label={$t('code.extensions')} class="p-1.5">
  {#snippet trigger(props)}
    <button
      type="button"
      class="aui-icon-button size-7 rounded-lg text-muted-foreground transition hover:text-foreground"
      aria-label={$t('code.extensions')}
      title={$t('code.extensions')}
      {...props}
    >
      <Puzzle class="size-3.5" />
    </button>
  {/snippet}
  <p class="px-2 pb-1.5 pt-1 text-[11px] font-semibold text-muted-foreground">{$t('code.extensions')}</p>
  {#each extensions as extension (extension.id)}
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={extension.enabled}
      class="aui-menu-item !items-start !py-2"
      onclick={() => void toggle(extension)}
    >
      <span class="check mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border border-border" class:is-on={extension.enabled}>
        {#if extension.enabled}<Check class="size-3" />{/if}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] font-medium text-foreground">{extension.name}</span>
        <span class="block text-[11px] leading-snug text-muted-foreground">{extension.description}</span>
      </span>
    </button>
  {:else}
    <p class="px-2 py-2 text-[12px] text-muted-foreground">{$t('code.noExtensions')}</p>
  {/each}
  <p class="px-2 pb-1 pt-2 text-[10px] leading-snug text-muted-foreground">{$t('code.extensionsHint')}</p>
</Menu>

<style>
  .check.is-on {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--primary-foreground);
  }
</style>
