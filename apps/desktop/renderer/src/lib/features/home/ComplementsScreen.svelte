<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ArrowLeft, ExternalLink, Globe, Plug, Plus, RotateCw, Terminal } from 'lucide-svelte';
  import type { Complement, ComplementChange, ComplementTransport } from '$shared/complements';
  import Button from '$lib/components/ui/Button.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import PageHeader from '$lib/components/ui/PageHeader.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { invoke } from '$lib/services/bridge';

  let { onBack }: { onBack?: () => void } = $props();
  let services = $state<Complement[]>([]);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state('');
  let formError = $state('');
  let editor = $state<Complement | 'new' | null>(null);
  let removing = $state(false);
  let name = $state('');
  let transport = $state<ComplementTransport>('http');
  let target = $state('');
  let args = $state('');
  let credentials = $state('');
  let credentialEditor = $state(false);
  let refreshing = false;
  const registry = 'https://registry.modelcontextprotocol.io/';
  const adapterGuide = 'https://github.com/punkpeye/mcp-remote#readme';

  function open(service: Complement | 'new') {
    editor = service;
    removing = false;
    formError = '';
    name = service === 'new' ? '' : service.name;
    transport = service === 'new' ? 'http' : service.transport;
    target = service === 'new' ? '' : service.target;
    args = service !== 'new' && service.args.length ? JSON.stringify(service.args) : '';
    credentials = '';
    credentialEditor = false;
  }

  function close() {
    if (busy) return;
    editor = null;
    credentials = '';
  }

  function changeTransport(value: string) {
    if (value === transport) return;
    transport = value === 'stdio' ? 'stdio' : 'http';
    target = '';
    credentials = '';
  }

  function message(failure: unknown): string {
    const text = failure instanceof Error ? failure.message : String(failure);
    return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const next = await invoke<Complement[]>('complements_list');
      if (!busy) { services = next; error = ''; }
    } catch (failure) {
      if (!busy) error = message(failure);
    } finally { loaded = true; refreshing = false; }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!busy && services.some(service => service.status === 'connecting' || service.status === 'connected')) void refresh();
    }, 1500);
    return () => clearInterval(timer);
  });

  async function change(request: ComplementChange, closeOnSuccess = false) {
    busy = true;
    error = '';
    formError = '';
    try {
      services = await invoke<Complement[]>('complements_change', request);
      if (closeOnSuccess) { editor = null; credentials = ''; }
    } catch (failure) {
      if (editor) formError = message(failure);
      else error = message(failure);
    } finally { busy = false; }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !editor) return;
    let argv: string[] = [];
    let values: Record<string, string> | undefined;
    if (transport === 'stdio' && args.trim()) {
      try {
        argv = JSON.parse(args);
        if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new Error();
      } catch { formError = $t('home.complements.invalidArgs'); return; }
    }
    if (credentials.trim()) {
      try {
        values = JSON.parse(credentials);
        if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(value => typeof value !== 'string')) throw new Error();
      } catch { formError = $t('home.complements.invalidCredentials'); return; }
    }
    void change({ action: 'save', id: editor === 'new' ? undefined : editor.id, settings: { name, transport, target, args: argv }, credentials: values }, true);
  }
</script>

<section class="complements-screen" aria-label={$t('home.complements.title')}>
  <div class="complements-content">
    <PageHeader title={$t('home.complements.title')} description={$t('home.complements.description')}>
      {#snippet actions()}
        {#if onBack}<Button variant="ghost" size="sm" onclick={onBack}><ArrowLeft /> {$t('artifacts.backToChat')}</Button>{/if}
        <Button size="sm" disabled={busy || !loaded} onclick={() => open('new')}><Plus /> {$t('home.complements.add')}</Button>
      {/snippet}
    </PageHeader>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if services.length}
      <ul class="complements-list">
        {#each services as service (service.id)}
          {@const Icon = service.transport === 'http' ? Globe : Terminal}
          <li class="complement-row">
            <Button variant="plain" class="complement-open" aria-haspopup="dialog" disabled={busy} onclick={() => open(service)}>
              <span class="icon"><Icon class="size-4" aria-hidden="true" /></span>
              <span class="complement-text">
                <span class="text-sm font-medium">{service.name}</span>
                <span class="text-xs text-muted-foreground truncate">{service.target}</span>
              </span>
            </Button>
            <span class="complement-status text-xs text-muted-foreground" aria-live="polite">
              {service.status === 'connected' ? $t('home.complements.toolCount', { values: { count: service.tools } }) : $t(`home.complements.status.${service.status}`)}
            </span>
            {#if service.status === 'failed' || service.status === 'unavailable'}
              <IconButton label={$t('home.complements.retry', { values: { name: service.name } })} variant="ghost" size="sm" disabled={busy} onclick={() => void change({ action: 'retry', id: service.id })}><RotateCw /></IconButton>
            {/if}
            <Switch label={service.name} checked={service.enabled} disabled={busy} onchange={enabled => void change({ action: 'enable', id: service.id, enabled })} />
          </li>
        {/each}
      </ul>
    {:else if loaded && !error}
      <div class="empty">
        <span class="icon"><Plug class="size-5" aria-hidden="true" /></span>
        <p class="text-sm font-medium">{$t('home.complements.empty')}</p>
        <p class="text-sm text-muted-foreground">{$t('home.complements.emptyHint')}</p>
      </div>
    {/if}
    <Button variant="ghost" size="sm" class="registry-link" onclick={() => void invoke('open_url_window', { url: registry })}>{$t('home.complements.browse')} <ExternalLink /></Button>
  </div>
</section>

{#if editor}
  <Dialog title={$t(removing ? 'home.complements.remove' : editor === 'new' ? 'home.complements.add' : 'home.complements.edit')} size="sm" onclose={close}>
    {#if removing && editor !== 'new'}
      <p class="form text-sm">{$t('home.complements.removePrompt', { values: { name: editor.name } })}</p>
    {:else}
      <form id="complement-settings" class="form" onsubmit={submit}>
        <label>{$t('home.complements.name')} <Input bind:value={name} required maxlength={80} disabled={busy} /></label>
        <div>
          <label id="complement-transport-label" for="complement-transport">{$t('home.complements.transport')}</label>
          <Select id="complement-transport" aria-labelledby="complement-transport-label" value={transport} disabled={busy}
            options={[{ value: 'http', label: $t('home.complements.http') }, { value: 'stdio', label: $t('home.complements.stdio') }]}
            onchange={changeTransport} />
        </div>
        <label>
          {$t(transport === 'http' ? 'home.complements.url' : 'home.complements.command')}
          <Input bind:value={target} placeholder={transport === 'http' ? 'https://example.com/mcp' : 'node'} required disabled={busy} spellcheck={false} />
        </label>
        {#if transport === 'stdio'}
          <label>
            {$t('home.complements.args')}
            <Input bind:value={args} placeholder={'["path/to/server.js"]'} disabled={busy} spellcheck={false} />
          </label>
          <p class="text-xs text-muted-foreground">{$t('home.complements.localHint')}</p>
        {/if}
        <Button variant="ghost" size="sm" class="credential-toggle" aria-expanded={credentialEditor} onclick={() => { credentialEditor = !credentialEditor; }}>
          {$t(transport === 'http' ? 'home.complements.headers' : 'home.complements.env')}
          {#if editor !== 'new' && editor.hasCredentials && editor.target === target && editor.transport === transport}
            <span class="text-xs text-muted-foreground">· {$t('home.complements.savedCredentials')}</span>
          {/if}
        </Button>
        {#if credentialEditor}
          <label>
            {$t('home.complements.credentials')}
            <Textarea bind:value={credentials} rows={2} autocomplete="off" spellcheck={false} disabled={busy}
              placeholder={transport === 'http' ? '{"Authorization":"Bearer …"}' : '{"API_KEY":"…"}'} />
          </label>
          <p class="text-xs text-muted-foreground">{$t('home.complements.credentialsHint')}</p>
        {/if}
        {#if transport === 'http'}
          <p class="text-xs text-muted-foreground">{$t('home.complements.oauthHint')}</p>
          <Button variant="ghost" size="sm" class="credential-toggle" onclick={() => void invoke('open_url_window', { url: adapterGuide })}>{$t('home.complements.adapterGuide')} <ExternalLink /></Button>
        {/if}
        {#if editor !== 'new' && editor.toolNames.length}
          <details class="text-xs text-muted-foreground">
            <summary>{$t('home.complements.availableTools')}</summary>
            <ul class="mt-1 list-disc pl-4 break-words">
              {#each editor.toolNames as tool, index (index)}<li>{tool}</li>{/each}
            </ul>
          </details>
        {/if}
      </form>
    {/if}
    {#if formError}<p class="error px-4" role="alert">{formError}</p>{/if}
    {#snippet footer()}
      {#if removing && editor !== 'new'}
        <Button variant="ghost" size="sm" disabled={busy} onclick={() => { removing = false; formError = ''; }}>{$t('home.complements.cancel')}</Button>
        <Button variant="destructive" size="sm" loading={busy} onclick={() => { if (editor && editor !== 'new') void change({ action: 'remove', id: editor.id }, true); }}>{$t('home.complements.remove')}</Button>
      {:else}
        {#if editor !== 'new'}
          <Button variant="ghost" size="sm" class="mr-auto" disabled={busy} onclick={() => { removing = true; formError = ''; }}>{$t('home.complements.remove')}</Button>
        {/if}
        <Button type="submit" form="complement-settings" size="sm" loading={busy}>{$t(editor === 'new' ? 'home.complements.connect' : 'home.complements.save')}</Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .complements-screen { min-width:0; min-height:0; flex:1; overflow-y:auto; }
  .complements-content { max-width:54rem; margin:0 auto; padding:2rem clamp(1.25rem, 4vw, 2rem) 3rem; }
  .complements-list { margin:1.5rem 0 0; padding:0; list-style:none; }
  .complement-row { display:flex; align-items:center; flex-wrap:wrap; gap:0.5rem 0.75rem; padding:0.375rem 0; border-bottom:1px solid var(--border-subtle); }
  :global(.complement-open) { display:flex; min-width:0; flex:1 1 12rem; align-items:center; gap:0.75rem; padding:0.375rem; text-align:left; }
  :global(.complement-open:hover) { background:var(--surface-hover); }
  .complement-text { display:grid; gap:0.125rem; min-width:0; }
  .complement-status { white-space:nowrap; }
  .icon { display:grid; place-items:center; inline-size:2rem; block-size:2rem; flex:none; border-radius:var(--radius-sm); background:var(--surface-hover); color:var(--muted-foreground); }
  .empty { display:grid; justify-items:start; gap:0.35rem; margin-top:2rem; }
  .empty .icon { margin-bottom:0.35rem; }
  :global(.registry-link) { margin:0.875rem 0 0 -0.375rem; }
  .form { display:grid; gap:0.75rem; padding:0.875rem 1rem; }
  label { display:grid; gap:0.25rem; font-size:var(--text-xs); font-weight:500; }
  .error { color:var(--destructive); font-size:var(--text-sm); margin:0.5rem 0; }
  :global(.credential-toggle) { justify-self:start; }
</style>
