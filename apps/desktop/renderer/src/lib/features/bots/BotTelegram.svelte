<svelte:options runes={true} />

<!--
  A bot on Telegram: connect it with the token @BotFather gives, then pair
  the people who may message it. A pairing code works once, for 10 minutes;
  "Read-only" people can chat and look things up, "Full access" is for you
  (tools run, with approval buttons in Telegram).
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ExternalLink, LoaderCircle, Send, X } from 'lucide-svelte';
  import { Button, Input, SegmentedControl } from '$lib/components/ui';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { botsIpc, type ChannelTrust, type TelegramStatus } from './bots-ipc';

  let { handle }: { handle: string } = $props();

  let status = $state<TelegramStatus | null>(null);
  let token = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let pairTrust = $state<ChannelTrust>('trusted');
  let timer: ReturnType<typeof setInterval> | undefined;

  const connecting = $derived(!!status?.connected && !status.username && !status.error);
  const botLink = $derived(status?.username ? `https://t.me/${status.username}` : null);

  async function refresh() {
    try {
      status = await botsIpc.telegram(handle);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  function watch(on: boolean) {
    clearInterval(timer);
    timer = on ? setInterval(() => void refresh(), 3000) : undefined;
  }

  // While connecting or while a code waits to be used, look again every few seconds.
  $effect(() => watch(connecting || !!status?.pairing));

  onMount(() => void refresh());
  onDestroy(() => clearInterval(timer));

  async function run(action: () => Promise<unknown>) {
    busy = true;
    error = null;
    try {
      await action();
      await refresh();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  function connect() {
    const value = token.trim();
    if (!value) return;
    void run(async () => {
      await botsIpc.telegramConnect(handle, value);
      token = '';
    });
  }

  function disconnect() {
    confirmStore.show({
      title: $t('bots.telegram.disconnectTitle'),
      message: $t('bots.telegram.disconnectMessage'),
      confirmLabel: $t('bots.telegram.disconnect'),
      danger: true,
      onConfirm: () => run(() => botsIpc.telegramDisconnect(handle))
    });
  }

  function minutesLeft(expires: string): number {
    return Math.max(1, Math.ceil((new Date(expires).getTime() - Date.now()) / 60_000));
  }
</script>

<div class="space-y-3">
  {#if !status}
    <p class="flex items-center gap-2 text-[12.5px] text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" /> {$t('bots.telegram.loading')}</p>
  {:else if !status.connected}
    <ol class="steps">
      <li>{$t('bots.telegram.step1')}</li>
      <li>{$t('bots.telegram.step2')}</li>
    </ol>
    <form class="flex gap-2" onsubmit={(event) => { event.preventDefault(); connect(); }}>
      <Input type="password" bind:value={token} placeholder="123456789:AA…" autocomplete="off" aria-label={$t('bots.telegram.token')} class="min-w-0 flex-1" />
      <Button type="submit" size="sm" loading={busy} disabled={!token.trim()}><Send /> {$t('bots.telegram.connect')}</Button>
    </form>
  {:else}
    <div class="flex items-center gap-2">
      <span class="dot" class:ok={!!status.username} class:bad={!!status.error}></span>
      <p class="min-w-0 flex-1 truncate text-[13px] text-foreground">
        {#if status.error}
          <span class="text-destructive">{status.error}</span>
        {:else if status.username}
          {$t('bots.telegram.connectedAs')} <a class="underline-offset-2 hover:underline" href={botLink} target="_blank" rel="noreferrer">@{status.username} <ExternalLink class="inline size-3" /></a>
        {:else}
          {$t('bots.telegram.connecting')}
        {/if}
      </p>
      <Button variant="ghost" size="sm" onclick={disconnect} disabled={busy}>{$t('bots.telegram.disconnect')}</Button>
    </div>

    <div class="space-y-2">
      <p class="text-[12px] font-medium text-muted-foreground">{$t('bots.telegram.people')}</p>
      {#if status.paired.length}
        <ul class="people">
          {#each status.paired as chat (chat.chat_id)}
            <li>
              <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{chat.name}</span>
              <span class="badge">{chat.trust === 'owner' ? $t('bots.telegram.full') : $t('bots.telegram.readOnly')}</span>
              <IconButton label={$t('bots.telegram.unpair', { values: { name: chat.name } })} size="xs" variant="ghost"
                type="button"
                class={uiClass("remove", "ui-local-f8c24190")}

                title={$t('bots.telegram.unpair', { values: { name: chat.name } })}
                onclick={() => run(() => botsIpc.telegramUnpair(handle, chat.chat_id))}
              ><X class="size-3.5" /></IconButton>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-[12.5px] text-muted-foreground">{$t('bots.telegram.nobody')}</p>
      {/if}

      {#if status.pairing}
        <div class="code-card" role="status">
          <p class="text-[12.5px] text-muted-foreground">
            {$t('bots.telegram.sendCode', { values: { bot: status.username ? `@${status.username}` : $t('bots.telegram.theBot'), minutes: minutesLeft(status.pairing.expires_at) } })}
          </p>
          <p class="code">/pair {status.pairing.code}</p>
          <p class="text-[13px] text-muted-foreground">{status.pairing.trust === 'owner' ? $t('bots.telegram.fullHint') : $t('bots.telegram.readOnlyHint')}</p>
        </div>
      {:else}
        <div class="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label={$t('bots.telegram.access')}
            value={pairTrust}
            options={[{ value: 'trusted', label: $t('bots.telegram.readOnly') }, { value: 'owner', label: $t('bots.telegram.full') }]}
            onchange={(value) => (pairTrust = value as ChannelTrust)}
          />
          <Button variant="outline" size="sm" disabled={busy} onclick={() => run(() => botsIpc.telegramPair(handle, pairTrust))}>{$t('bots.telegram.pair')}</Button>
        </div>
      {/if}
    </div>
  {/if}
  {#if error}<p class="text-[12px] text-destructive" role="alert">{error}</p>{/if}
</div>

<style>
  .steps {
    margin: 0;
    padding-left: 1.1rem;
    list-style: decimal;
    font-size: 12.5px;
    color: var(--muted-foreground);
  }
  .steps li + li { margin-top: 0.2rem; }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--warning);
  }
  .dot.ok { background: var(--success); }
  .dot.bad { background: var(--error); }
  .people {
    display: flex;
    flex-direction: column;
  }
  .people li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.4rem 0.35rem 0.65rem;
  }
  .people li + li { border-top: 1px solid var(--border-subtle); }
  .badge {
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--surface-hover);
    padding: 0.05rem 0.5rem;
    font-size: 11px;
    color: var(--muted-foreground);
  }
  :global(.remove.ui-local-f8c24190) {
    display: inline-flex;
    height: 1.5rem;
    width: 1.5rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: var(--muted-foreground);
  }
  :global(.remove:hover.ui-local-f8c24190) { background: var(--surface-hover); color: var(--foreground); }
  .code-card {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    border-radius: 0.75rem;
    background: var(--surface-hover);
    padding: 0.75rem 0.9rem;
  }
  .code {
    font-variant-numeric: tabular-nums;
    font-size: 18px;
    font-weight: 500;
    letter-spacing: 0.06em;
    color: var(--foreground);
    user-select: all;
  }
</style>
