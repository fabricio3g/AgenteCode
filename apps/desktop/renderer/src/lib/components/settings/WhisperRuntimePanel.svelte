<svelte:options runes={true} />

<!-- whisper.cpp builds on this machine: pick the one dictation uses, add a custom build, delete old ones. -->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Check, FolderInput, LoaderCircle, Trash2 } from '$lib/icons';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { deleteWhisperRuntime, listWhisperRuntimes, pickWhisperRuntimeFile, type WhisperRuntime } from '$lib/services/stt';
  import { Badge, Button, Tooltip } from '$lib/components/ui';
  import SettingsSection from './SettingsSection.svelte';

  let runtimes = $state<WhisperRuntime[]>([]);
  let loading = $state(false);

  async function load() {
    loading = true;
    try {
      runtimes = await listWhisperRuntimes();
    } catch {
      runtimes = [];
    } finally {
      loading = false;
    }
  }

  async function use(path: string) {
    await appStore.updateSttSettings({ runtime_path: path });
    await load();
  }

  async function chooseCustom() {
    const path = await pickWhisperRuntimeFile().catch(() => null);
    if (path) await use(path);
  }

  async function remove(runtime: WhisperRuntime) {
    const accepted = await confirmStore.ask({
      title: $t('voice.deleteRuntimeTitle', { values: { name: runtime.variant } }),
      message: $t('voice.deleteRuntimeMessage'),
      confirmLabel: $t('voice.delete'),
      danger: true
    });
    if (!accepted) return;
    await deleteWhisperRuntime(runtime.path);
    await load();
  }

  onMount(() => void load());
</script>

<SettingsSection title={$t('voice.whisperRuntime')}>
  {#snippet actions()}
    <Button variant="ghost" size="sm" onclick={() => void chooseCustom()}><FolderInput /> {$t('voice.customBuild')}</Button>
  {/snippet}
  {#if loading && !runtimes.length}
    <p class="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" /> {$t('voice.scanning')}</p>
  {:else if !runtimes.length}
    <p class="px-4 py-3 text-xs text-muted-foreground">{$t('voice.noWhisperRuntime')}</p>
  {:else}
    {#each runtimes as runtime (runtime.path)}
      <div class="flex items-center gap-3 px-4 py-3">
        <span class="flex size-4 shrink-0 items-center justify-center rounded-full border {runtime.is_active ? 'border-foreground bg-foreground text-background' : 'border-[var(--float-border)]'}">
          {#if runtime.is_active}<Check class="size-2.5" />{/if}
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-[length:var(--text-sm)] font-medium text-foreground">{runtime.variant}</p>
          <p class="truncate text-xs text-muted-foreground" title={runtime.path}>{runtime.path}</p>
        </div>
        {#if runtime.is_active}
          <Badge tone="success">{$t('voice.inUse')}</Badge>
        {:else}
          <Button variant="outline" size="sm" onclick={() => void use(runtime.path)}>{$t('voice.use')}</Button>
        {/if}
        <Tooltip label={$t('voice.deleteRuntimeTitle', { values: { name: runtime.variant } })} position="bottom"><IconButton label={$t('voice.deleteRuntimeTitle', { values: { name: runtime.variant } })} variant="ghost" size="sm" class="text-muted-foreground hover:text-error" onclick={() => void remove(runtime)} >
          <Trash2 />
        </IconButton></Tooltip>
      </div>
    {/each}
  {/if}
</SettingsSection>
