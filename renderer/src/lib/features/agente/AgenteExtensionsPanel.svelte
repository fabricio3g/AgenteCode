<svelte:options runes={true} />

<script lang="ts">
  import { Puzzle } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { listAgenteExtensions, setAgenteExtensionEnabled, type AgenteExtensionInfo } from './agente-ipc';

  let open = $state(false);
  let extensions = $state<AgenteExtensionInfo[]>([]);

  async function refresh() {
    extensions = await listAgenteExtensions().catch(() => []);
  }

  function togglePanel() {
    open = !open;
    if (open) void refresh();
  }

  async function toggle(extension: AgenteExtensionInfo) {
    const next = !extension.enabled;
    extension.enabled = next;
    extensions = [...extensions];
    const result = await setAgenteExtensionEnabled(extension.id, next);
    if (!result.ok) {
      extension.enabled = !next;
      extensions = [...extensions];
    }
  }
</script>

<div class="relative">
  <button
    type="button"
    class="aui-icon-button size-7 rounded-lg text-muted-foreground transition hover:text-foreground"
    onclick={togglePanel}
    aria-label={$t('agente.extensions')}
    title={$t('agente.extensions')}
  >
    <Puzzle class="size-3.5" />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-40" onclick={() => (open = false)}></div>
    <div class="absolute right-0 top-9 z-50 w-72 rounded-xl border border-border bg-popover p-2 shadow-lg">
      <p class="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {$t('agente.extensions')}
      </p>
      {#each extensions as extension (extension.id)}
        <label class="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-muted">
          <input
            type="checkbox"
            class="mt-0.5 size-3.5 accent-[var(--primary)]"
            checked={extension.enabled}
            onchange={() => void toggle(extension)}
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px] font-medium text-foreground">{extension.name}</span>
            <span class="block text-[11px] leading-snug text-muted-foreground">{extension.description}</span>
          </span>
        </label>
      {:else}
        <p class="px-2 py-2 text-[12px] text-muted-foreground">{$t('agente.noExtensions')}</p>
      {/each}
      <p class="px-2 pb-1 pt-2 text-[10px] leading-snug text-muted-foreground">{$t('agente.extensionsHint')}</p>
    </div>
  {/if}
</div>
