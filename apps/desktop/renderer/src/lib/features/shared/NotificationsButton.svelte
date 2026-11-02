<svelte:options runes={true} />
<script lang="ts">
  import { onMount } from 'svelte';
  import { Bell } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { invoke, listen } from '$lib/services/bridge';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ActivityNotification, ActivityNotificationState } from '$shared/notifications';
  import { toastStore } from '$lib/stores/toast.svelte';
  let open = $state(false);
  let items = $state<ActivityNotification[]>([]);
  let enabled = $state(true);
  const unread = $derived(items.filter(item => !item.read).length);
  async function action(action: string, id?: string) {
    try {
      const result = await invoke<ActivityNotificationState>('activity_notifications_action', { action, id, enabled: !enabled });
      items = result.items; enabled = result.enabled;
    } catch (error) { toastStore.error(String(error)); }
  }
  onMount(() => {
    let disposed = false; const off: Array<() => void> = [];
    void (async () => {
      const add = (fn: () => void) => { if (disposed) fn(); else off.push(fn); };
      add(await listen<ActivityNotificationState>('activity_notifications', value => { items = value.items; enabled = value.enabled; }));
      add(await listen<{chatId: string}>('activity_notification_open', ({chatId}) => appStore.selectChat(chatId)));
      const initial = await invoke<ActivityNotificationState>('activity_notifications_list');
      if (!disposed) { items = initial.items; enabled = initial.enabled; }
    })().catch(() => {});
    return () => { disposed = true; off.forEach(fn => fn()); };
  });
</script>
<Menu bind:open placement="bottom-end" minWidth="19rem" label="Notifications">
  {#snippet trigger(props)}
    <IconButton label={`Notifications${unread ? ` · ${unread} unread` : ''}`} size="sm" type="button" class="titlebar-no-drag" {...props}>
      <span class="notification-icon"><Bell class="size-4" />{#if unread}<span class="unread-dot"></span>{/if}</span>
    </IconButton>
  {/snippet}
  <div class="notification-heading">Notifications <span>{unread ? `${unread} unread` : ''}</span></div>
  {#if !items.length}<p class="notification-empty">You're all caught up.</p>{/if}
  {#each items.slice(0, 15) as item (item.id)}
    <MenuItem label={`${item.read ? '' : '• '}${item.title}`} description={item.body} onselect={() => void action('open', item.id)} />
  {/each}
  {#if items.length}<MenuItem label="Mark all read" onselect={() => void action('read')} /><MenuItem label="Clear notifications" onselect={() => void action('clear')} />{/if}
  <MenuItem label={enabled ? 'Desktop notifications on' : 'Desktop notifications off'} active={enabled} keepOpen onselect={() => void action('enable')} />
</Menu>
<style>
  .notification-icon { position:relative; display:flex; }
  .unread-dot { position:absolute; right:-2px; top:-2px; width:5px; height:5px; border-radius:50%; background:var(--foreground); }
  .notification-heading { display:flex; justify-content:space-between; gap:1rem; padding:0.375rem 0.625rem; font-size:var(--text-sm); }
  .notification-heading span,.notification-empty { color:var(--muted-foreground); font-size:var(--text-xs); }
  .notification-empty { padding:0.75rem 0.625rem; }
</style>
