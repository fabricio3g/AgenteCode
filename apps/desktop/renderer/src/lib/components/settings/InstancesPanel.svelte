<svelte:options runes={true} />

<!--
  Models → Running: every local model instance, like LM Studio's loaded
  models. Each one has its own port, parallel request slots and key; chat uses
  one of them, and any of them can be shared on the local network.
-->

<script lang="ts">
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Check, Copy, Cpu, Eye, EyeOff, Plus, Square, Wifi } from 'lucide-svelte';
  import { Button, Menu, MenuItem, Switch } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { instancesStore, type LocalInstance } from '$lib/stores/instances.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import SettingsSection from './SettingsSection.svelte';

  let {
    loadPhase = '',
    loadProgress = 0,
    onlibrary
  }: { loadPhase?: string; loadProgress?: number; onlibrary?: () => void } = $props();

  let busy = $state<string | null>(null);
  let revealed = $state<Record<string, string>>({});
  let copied = $state('');

  let pickerOpen = $state(false);

  const library = $derived(modelsStore.availableModels);

  onMount(() => {
    void instancesStore.watch();
    void instancesStore.refresh();
  });

  /** The full load dialog, in "another instance" mode. */
  function startWith(model: (typeof library)[number]) {
    pickerOpen = false;
    void appStore.openLocalModelLoadDialog(model as never, { asInstance: true });
  }

  async function run(id: string, action: () => Promise<void>) {
    busy = id;
    try {
      await action();
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    } finally {
      busy = null;
    }
  }

  async function copy(text: string, id: string) {
    try {
      if (!await writeToClipboard(text)) return;
      copied = id;
      setTimeout(() => { if (copied === id) copied = ''; }, 1400);
    } catch { /* clipboard blocked */ }
  }

  async function toggleKey(instance: LocalInstance) {
    if (revealed[instance.id]) {
      const { [instance.id]: _, ...rest } = revealed;
      revealed = rest;
    } else {
      revealed = { ...revealed, [instance.id]: await instancesStore.key(instance.id) };
    }
  }

  function statusTone(state: string): 'ready' | 'busy' | 'error' {
    if (state === 'error') return 'error';
    return state === 'ready' || state === 'model_ready' ? 'ready' : 'busy';
  }

  function contextLabel(instance: LocalInstance): string {
    if (!instance.context) return '';
    const perSlot = Math.round(instance.context / Math.max(1, instance.parallel) / 1024);
    return $t('instances.contextEach', { values: { n: perSlot } });
  }
</script>

{#snippet endpoint(label: string, value: string, id: string)}
  <div class="endpoint">
    <span class="endpoint-label">{label}</span>
    <code class="endpoint-value" title={value}>{value}</code>
    <Button variant="plain" type="button" class={uiClass("endpoint-btn", "ui-local-5540e50e")} onclick={() => void copy(value, id)} aria-label={$t('instances.copy')} title={$t('instances.copy')}>
      {#if copied === id}<Check class="size-3.5" />{:else}<Copy class="size-3.5" />{/if}
    </Button>
  </div>
{/snippet}

<div class="flex items-center justify-between gap-3">
  <p class="text-[length:var(--text-sm)] text-muted-foreground">
    {instancesStore.running.length ? $t('instances.count', { values: { n: instancesStore.running.length } }) : ''}
  </p>
  <Menu bind:open={pickerOpen} placement="bottom-end" minWidth="18rem" label={$t('instances.startAnother')}>
    {#snippet trigger(props)}
      <Button size="sm" disabled={!library.length} {...props}><Plus /> {$t('instances.startAnother')}</Button>
    {/snippet}
    <p class="px-2.5 pb-1 pt-1.5 text-[length:var(--text-xs)] font-semibold text-muted-foreground">{$t('instances.pickModel')}</p>
    {#each library as model (model.path)}
      <MenuItem
        label={model.name}
        description={instancesStore.list.some((i) => i.model_path === model.path) ? $t('instances.alreadyRunning') : model.size_gb ? `${Number(model.size_gb).toFixed(1)} GB` : undefined}
        onselect={() => startWith(model)}
      />
    {/each}
  </Menu>
</div>

{#if !instancesStore.running.length}
  <SettingsSection>
    <div class="flex flex-col items-center gap-2 py-8 text-center">
      <Cpu class="size-5 text-muted-foreground" />
      <p class="text-sm font-medium text-foreground">{$t('modelHub.noneLoaded')}</p>
      <p class="text-xs text-muted-foreground">{$t('instances.emptyHint')}</p>
      <Button variant="outline" size="sm" class="mt-1" onclick={() => onlibrary?.()}>{$t('modelHub.goLibrary')}</Button>
    </div>
  </SettingsSection>
{/if}

{#each instancesStore.running as instance (instance.id)}
  {@const tone = statusTone(instance.state)}
  {@const inChat = instancesStore.inChat(instance)}
  <SettingsSection>
    <div class="flex items-center gap-3 py-3">
      <span class="dot {tone}" aria-hidden="true"></span>
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-foreground">
          <span class="truncate" title={instance.model_path}>{instance.model_id.replace(/\.gguf$/i, '')}</span>
          {#if inChat}<span class="chip good">{$t('instances.inChat')}</span>{/if}
          {#if instance.shared}<span class="chip info"><Wifi class="size-2.5" />{$t('instances.shared')}</span>{/if}
        </p>
        <p class="truncate text-xs text-muted-foreground">
          {[
            instance.port ? $t('instances.port', { values: { n: instance.port } }) : '',
            $t('instances.parallel', { values: { n: instance.parallel } }),
            contextLabel(instance),
            tone === 'busy' ? (instance.main && loadPhase ? `${loadPhase} · ${Math.round(loadProgress)}%` : $t('instances.starting')) : ''
          ].filter(Boolean).join(' · ')}
        </p>
      </div>
      <Button variant="ghost" size="sm" class="text-muted-foreground" loading={busy === instance.id} onclick={() => void run(instance.id, () => instancesStore.stop(instance.id))}>
        <Square /> {$t('instances.stop')}
      </Button>
    </div>

    {#if instance.error}
      <p class="py-2.5 text-xs text-error">{instance.error}</p>
    {/if}

    {#if tone === 'ready'}
      <div class="space-y-1 py-3">
        {#if instance.local_url}{@render endpoint($t('instances.localUrl'), instance.local_url, `${instance.id}-local`)}{/if}
        {#if instance.lan_url}{@render endpoint($t('instances.networkUrl'), instance.lan_url, `${instance.id}-lan`)}{/if}
        <div class="endpoint">
          <span class="endpoint-label">{$t('instances.apiKey')}</span>
          <code class="endpoint-value">{revealed[instance.id] || '••••••••••••••••••••••••'}</code>
          <Button variant="plain" type="button" class={uiClass("endpoint-btn", "ui-local-5540e50e")} onclick={() => void toggleKey(instance)} aria-label={$t('instances.showKey')} title={$t('instances.showKey')}>
            {#if revealed[instance.id]}<EyeOff class="size-3.5" />{:else}<Eye class="size-3.5" />{/if}
          </Button>
          <Button variant="plain" type="button" class={uiClass("endpoint-btn", "ui-local-5540e50e")} onclick={async () => void copy(revealed[instance.id] || await instancesStore.key(instance.id), `${instance.id}-key`)} aria-label={$t('instances.copy')} title={$t('instances.copy')}>
            {#if copied === `${instance.id}-key`}<Check class="size-3.5" />{:else}<Copy class="size-3.5" />{/if}
          </Button>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 py-3">
        <label class="flex items-center gap-2.5 text-[length:var(--text-sm)] text-foreground">
          <Switch
            checked={instance.shared}
            disabled={busy === instance.id}
            label={$t('instances.shareOnNetwork')}
            onchange={(on) => void run(instance.id, () => instancesStore.share(instance.id, on))}
          />
          <span>
            {$t('instances.shareOnNetwork')}
            <span class="block text-xs text-muted-foreground">{$t('instances.shareHint')}</span>
          </span>
        </label>
        {#if !inChat}
          <Button variant="outline" size="sm" onclick={() => void run(instance.id, () => instancesStore.useInChat(instance))}>{$t('instances.useInChat')}</Button>
        {/if}
      </div>
    {/if}
  </SettingsSection>
{/each}

<style>
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--muted-foreground);
  }

  .dot.ready { background: var(--success, #22a06b); }
  .dot.busy { background: var(--warning, #d4a017); animation: pulse 1.2s ease-in-out infinite; }
  .dot.error { background: var(--error); }

  @keyframes pulse { 50% { opacity: 0.35; } }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0 0.45rem;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: 500;
  }


  .endpoint {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2rem;
    padding: 0 0.3rem 0 0.7rem;
    border-radius: 0.55rem;
    background: var(--muted);
  }

  .endpoint-label {
    width: 5.5rem;
    flex-shrink: 0;
    font-size: 0.72rem;
    color: var(--muted-foreground);
  }

  .endpoint-value {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--foreground);
  }

  :is(.endpoint-btn, :global(.endpoint-btn.ui-local-5540e50e)) {
    display: inline-flex;
    width: 1.6rem;
    height: 1.6rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 0.4rem;
    background: transparent;
    color: var(--muted-foreground);
  }

  :is(.endpoint-btn:hover, :global(.endpoint-btn:hover.ui-local-5540e50e)) {
    background: var(--background);
    color: var(--foreground);
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.busy { animation: none; }
  }
</style>
