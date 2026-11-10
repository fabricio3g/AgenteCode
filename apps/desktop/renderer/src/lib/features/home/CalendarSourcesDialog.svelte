<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import { ArrowLeft, CalendarDays, Link2, Plus, RefreshCw, Trash2 } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { invoke } from '$lib/services/bridge';
  import type { CalendarAccountProvider, CalendarAccountSelection, SyncedCalendar } from '$shared/calendar-sync';
  import { calendarChange, calendarSync } from './calendar-sync.svelte';

  type Screen = 'manage' | 'choose' | 'link' | 'signing' | 'pick' | 'remove';
  let { manage = false, onclose }: { manage?: boolean; onclose: () => void } = $props();
  let screen = $state<Screen>(untrack(() => manage ? 'manage' : 'choose'));
  let name = $state('');
  let url = $state('');
  let error = $state('');
  let busy = $state(false);
  let pending = $state<CalendarAccountSelection>();
  let selected = $state<string[]>([]);
  let removal = $state<SyncedCalendar>();
  let attempt = 0;
  const providers = ['google', 'outlook'] as const;
  const dateFormat = $derived(new Intl.DateTimeFormat($locale || 'en', { dateStyle: 'medium', timeStyle: 'short' }));

  function go(next: Screen) {
    error = '';
    screen = next;
  }

  function cancelSignIn() {
    ++attempt;
    pending = undefined;
    selected = [];
    void invoke('calendar_sync_cancel_sign_in').catch(() => {});
  }

  function close() {
    if (busy) return;
    onclose();
  }
  onDestroy(() => {
    if (screen === 'signing' || screen === 'pick') cancelSignIn();
  });

  function back() {
    if (screen === 'signing' || screen === 'pick') cancelSignIn();
    go(screen === 'remove' ? 'manage' : screen === 'choose' ? 'manage' : 'choose');
  }

  function message(failure: unknown) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    return detail.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }

  async function signIn(provider: CalendarAccountProvider, reconnect?: string) {
    const current = ++attempt;
    go('signing');
    try {
      const selection = await invoke<CalendarAccountSelection>('calendar_sync_sign_in', { provider, reconnect });
      if (current !== attempt) return;
      pending = selection;
      selected = selection.calendars.filter(calendar => selection.calendars.length === 1 || calendar.primary).slice(0, 1).map(calendar => calendar.id);
      go('pick');
    } catch (failure) {
      if (current !== attempt) return;
      go('choose');
      error = message(failure);
    }
  }

  async function change(channel: string, args: Record<string, unknown>, after?: Screen) {
    busy = true;
    error = '';
    try {
      await calendarChange(channel, args);
      if (after) go(after);
      url = '';
      name = '';
      return true;
    } catch (failure) {
      error = message(failure);
      return false;
    } finally { busy = false; }
  }

  function saveLink(event: SubmitEvent) {
    event.preventDefault();
    if (!busy) void change('calendar_sync_add_link', { name, url }, 'manage');
  }
</script>

<Dialog title={$t(screen === 'manage' ? 'home.calendarSync.manage' : screen === 'remove' ? 'home.calendarSync.remove' : 'home.calendarSync.add')} size="sm" onclose={close}>
  <div class="content">
    {#if screen === 'manage'}
      {#if calendarSync.calendars.length}
        <ul class="calendars">
          {#each calendarSync.calendars as calendar (calendar.id)}
            <li>
              <CalendarDays class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div class="source">
                <strong>{calendar.name}</strong>
                <span>{$t(`home.calendarSync.providers.${calendar.provider}`)} · {$t('home.calendarSync.readOnly')}</span>
                {#if calendar.error}<span>{$t(`home.calendarSync.errors.${calendar.error}`)}</span>{/if}
                {#if calendar.lastSynced}<span>{$t('home.calendarSync.lastSynced', { values: { time: dateFormat.format(calendar.lastSynced) } })}</span>
                {:else if !calendar.error}<span>{$t('home.calendarSync.syncing')}</span>{/if}
              </div>
              {#if calendar.error === 'signIn' && calendar.provider !== 'link' && calendarSync.providers[calendar.provider]}
                <Button variant="ghost" size="sm" disabled={busy} onclick={() => {
                  if (calendar.provider !== 'link') void signIn(calendar.provider, calendar.id);
                }}>{$t('home.calendarSync.reconnect')}</Button>
              {:else}
                <IconButton variant="ghost" label={$t('home.calendarSync.refresh')} size="sm" disabled={busy} onclick={() => void change('calendar_sync_refresh', { id: calendar.id })}><RefreshCw /></IconButton>
              {/if}
              <IconButton variant="ghost" label={$t('home.calendarSync.remove')} size="sm" disabled={busy} onclick={() => { removal = calendar; go('remove'); }}><Trash2 /></IconButton>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-sm text-muted-foreground">{$t('home.calendarSync.empty')}</p>
      {/if}
    {:else if screen === 'choose'}
      <p class="text-sm text-muted-foreground">{$t('home.calendarSync.description')}</p>
      <Button variant="secondary" class="source-option" onclick={() => go('link')}><Link2 /> {$t('home.calendarSync.subscribe')}</Button>
      {#each providers as provider (provider)}
        <Button variant="secondary" class="source-option" disabled={!calendarSync.providers[provider]} onclick={() => void signIn(provider)}>
          <CalendarDays /> {$t(`home.calendarSync.providers.${provider}`)}
        </Button>
      {/each}
      {#if !calendarSync.providers.google || !calendarSync.providers.outlook}<p class="text-xs text-muted-foreground">{$t('home.calendarSync.signInUnavailable')}</p>{/if}
    {:else if screen === 'link'}
      <form id="calendar-link-form" class="content link-form" onsubmit={saveLink}>
        <label>{$t('home.calendarSync.link')} <Input type="password" bind:value={url} autocomplete="off" placeholder="https://…" maxlength={4096} required /></label>
        <label>{$t('home.calendarSync.name')} <Input bind:value={name} maxlength={80} /></label>
        <p class="text-xs text-muted-foreground">{$t('home.calendarSync.linkHelp')}</p>
      </form>
    {:else if screen === 'signing'}
      <p class="text-sm" role="status">{$t('home.calendarSync.signInBrowser')}</p>
    {:else if screen === 'pick' && pending}
      <fieldset>
        <legend class="text-sm font-medium">{$t('home.calendarSync.pick')}</legend>
        {#each pending.calendars as calendar (calendar.id)}
          <label class="pick-row"><input type="checkbox" value={calendar.id} bind:group={selected} /> {calendar.name}</label>
        {:else}
          <p class="text-sm text-muted-foreground">{$t('home.calendarSync.noCalendars')}</p>
        {/each}
      </fieldset>
    {:else if screen === 'remove' && removal}
      <p class="text-sm">{$t('home.calendarSync.removePrompt', { values: { name: removal.name } })}</p>
    {/if}
    {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
  </div>
  {#snippet footer()}
    {#if screen === 'manage'}
      <Button size="sm" disabled={busy} onclick={() => go('choose')}><Plus /> {$t('home.calendarSync.add')}</Button>
    {:else}
      <Button variant="ghost" size="sm" class="mr-auto" disabled={busy} onclick={back}><ArrowLeft /> {$t('home.calendarSync.back')}</Button>
      {#if screen === 'link'}
        <Button size="sm" type="submit" form="calendar-link-form" loading={busy}>{$t('home.calendarSync.subscribe')}</Button>
      {:else if screen === 'pick' && pending}
        <Button size="sm" disabled={!selected.length} loading={busy} onclick={() => {
          if (pending) void change('calendar_sync_select', { session: pending.session, calendarIds: selected }, 'manage');
        }}>{$t('home.calendarSync.add')}</Button>
      {:else if screen === 'remove' && removal}
        <Button variant="destructive" size="sm" loading={busy} onclick={() => {
          if (removal) void change('calendar_sync_remove', { id: removal.id }, 'manage');
        }}>{$t('home.calendarSync.remove')}</Button>
      {/if}
    {/if}
  {/snippet}
</Dialog>

<style>
  .content { display:grid; gap:0.75rem; padding:0.875rem 1rem; }
  .link-form { padding:0; }
  .link-form label { display:grid; gap:0.25rem; font-size:var(--text-sm); }
  :global(.source-option) { justify-content:flex-start; }
  .calendars { margin:0; padding:0; list-style:none; }
  li { display:flex; align-items:center; gap:0.5rem; padding:0.5rem 0; border-bottom:1px solid var(--border-subtle); }
  .source { display:grid; flex:1; min-width:0; font-size:var(--text-xs); color:var(--text-secondary); overflow-wrap:anywhere; }
  .source strong { font-size:var(--text-sm); font-weight:500; color:var(--foreground); }
  .pick-row { display:flex; gap:0.5rem; align-items:center; padding:0.375rem 0; font-size:var(--text-sm); }
</style>
