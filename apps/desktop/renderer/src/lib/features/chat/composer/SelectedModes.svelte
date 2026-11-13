<script lang="ts">
  import { slide } from 'svelte/transition';
  import { Search, ChevronDown } from '$lib/icons';
  import { appStore } from '$lib/stores/app.svelte';
  import ModeSelector from './ModeSelector.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  let open=$state(false);
  const options=[{id:'chat' as const,label:'Off'},{id:'search' as const,label:'Web search'},{id:'deep' as const,label:'Deep research'},{id:'max' as const,label:'Research Max'}];
  const selected=$derived(options.find(option=>option.id===appStore.searchMode));
  const motionDuration=()=>document.documentElement.classList.contains('a11y-reduce-motion')||matchMedia('(prefers-reduced-motion: reduce)').matches?0:140;
</script>
<div class="selected-mode-bar" aria-label="Selected modes">
  <ModeSelector />
  {#if appStore.searchMode!=='chat'}<div class="selected-research" transition:slide={{duration:motionDuration()}}><span class="selected-mode-caption">Research</span><Menu bind:open placement="top-start" label="Research mode">{#snippet trigger(props)}<Button variant="plain" class="selected-mode-control" {...props}><Search class="size-3.5"/><span>{selected?.label}</span><ChevronDown class="size-3"/></Button>{/snippet}{#each options as option}<MenuItem label={option.label} active={appStore.searchMode===option.id} onselect={()=>appStore.setSearchMode(option.id)}/>{/each}</Menu></div>{/if}
</div>
