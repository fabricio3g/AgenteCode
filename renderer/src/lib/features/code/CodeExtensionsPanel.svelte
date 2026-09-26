<svelte:options runes={true} />

<!--
  Extension toggles for the Code agent, in the shared Menu (Escape, outside
  click and keyboard all work). Each row is a switch; toggling keeps the
  menu open. Built-in extensions show translated names; third-party ones
  show what they declare.
-->

<script lang="ts">
  import { Puzzle } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import Menu from '$lib/components/ui/Menu.svelte';
  import { listAgenteExtensions, setAgenteExtensionEnabled, type AgenteExtensionInfo } from './code-ipc';

  let open = $state(false);
  let extensions = $state<AgenteExtensionInfo[]>([]);

  const BUILT_IN: Record<string, string> = { 'git-tools': 'gitTools', 'safety-rails': 'safetyRails' };
  const enabledCount = $derived(extensions.filter((e) => e.enabled).length);

  $effect(() => {
    if (open) void listAgenteExtensions().then((list) => (extensions = list), () => (extensions = []));
  });

  function text(extension: AgenteExtensionInfo, field: 'name' | 'description'): string {
    const key = BUILT_IN[extension.id];
    return key ? get(t)(`code.ext.${key}.${field}`) : extension[field];
  }

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

<Menu bind:open placement="bottom-end" minWidth="20rem" label={$t('code.extensions')} class="max-w-[22rem] p-1.5">
  {#snippet trigger(props)}
    <button
      type="button"
      class="aui-icon-button size-8 rounded-lg text-muted-foreground transition hover:text-foreground"
      aria-label={$t('code.extensions')}
      title={$t('code.extensions')}
      {...props}
    >
      <Puzzle class="size-4" />
    </button>
  {/snippet}
  <div class="flex items-baseline justify-between px-2.5 pb-1.5 pt-1">
    <p class="text-[13px] font-medium text-foreground">{$t('code.extensions')}</p>
    {#if extensions.length}
      <p class="text-[11px] tabular-nums text-muted-foreground">{$t('code.ext.enabledCount', { values: { n: enabledCount, total: extensions.length } })}</p>
    {/if}
  </div>
  {#each extensions as extension (extension.id)}
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={extension.enabled}
      class="aui-menu-item ext-row"
      onclick={() => void toggle(extension)}
    >
      <span class="min-w-0 flex-1 text-left">
        <span class="block truncate text-[13px] font-medium text-foreground">{text(extension, 'name')}</span>
        <span class="block text-[11.5px] leading-snug text-muted-foreground">{text(extension, 'description')}</span>
      </span>
      <span class="switch" class:is-on={extension.enabled} aria-hidden="true"><span class="knob"></span></span>
    </button>
  {:else}
    <p class="px-2.5 py-2 text-[12px] text-muted-foreground">{$t('code.noExtensions')}</p>
  {/each}
  <p class="ext-note">{$t('code.extensionsHint')}</p>
</Menu>

<style>
  .ext-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
  }
  .switch {
    position: relative;
    width: 2rem;
    height: 1.125rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--muted);
    border: 1px solid var(--border);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .switch.is-on {
    background: var(--primary);
    border-color: var(--primary);
  }
  .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 0.875rem;
    height: 0.875rem;
    border-radius: 9999px;
    background: var(--background);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
    transition: transform var(--motion-fast) var(--motion-ease);
  }
  .switch.is-on .knob {
    transform: translateX(0.875rem);
  }
  .ext-note {
    margin-top: 0.25rem;
    padding: 0.5rem 0.625rem 0.25rem;
    border-top: 1px solid var(--border-subtle);
    font-size: 11px;
    line-height: 1.45;
    color: var(--muted-foreground);
    user-select: none;
  }
</style>
