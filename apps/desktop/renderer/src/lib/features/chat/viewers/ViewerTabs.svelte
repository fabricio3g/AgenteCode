<script lang="ts">
  import { t } from 'svelte-i18n';
  import TabBar from '$lib/components/ui/TabBar.svelte';
  let { items, active, onchange }: { items: Array<{ id: string; title: string }>; active: string; onchange: (id: string) => void } = $props();
</script>
{#if items.length > 1}<TabBar value={active} options={items.map(item => ({ value: item.id, label: item.title }))} label={$t('artifacts.group.documents')} {onchange} />{/if}
