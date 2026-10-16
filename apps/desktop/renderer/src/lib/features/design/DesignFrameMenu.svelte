<svelte:options runes={true} />

<!--
  The menu on a board frame's label: zoom to it, ask the agent for a variant of
  it, use a variant, delete a page or variant. It opens from its ⋯ button or,
  through `openAt`, where the label was right-clicked.
-->

<script lang="ts">
  import { Check, GalleryHorizontal, Maximize2, MoreHorizontal, Trash2 } from 'lucide-svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import { designStore } from './design.svelte';
  import { pageLabel, type BoardFrame } from './design-view';

  let { frame }: { frame: BoardFrame } = $props();

  let open = $state(false);
  let anchorPoint = $state<{ x: number; y: number } | null>(null);

  /** Opens the menu at a screen point (a right-click on the label). */
  export function openAt(point: { x: number; y: number }) {
    anchorPoint = point;
    open = true;
  }

  /** Puts a variant request for this page in the composer, ready for the user to say how it should differ. */
  function askVariant() {
    designStore.select(frame.page, frame.key);
    appStore.composer = copy.design.frame.variantPrompt.replace('{page}', frame.page);
    if (!designStore.chatOpen) designStore.toggleChat();
    window.dispatchEvent(new Event('focus-composer'));
  }

  async function remove() {
    const accepted = await confirmStore.ask({
      title: copy.design.frame.removeTitle.replace('{page}', pageLabel(frame.page)),
      message: copy.design.frame.removeMessage,
      confirmLabel: copy.design.frame.removeConfirm,
      danger: true
    });
    if (!accepted) return;
    try {
      await designStore.removePage(frame.page);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : String(error));
    }
  }
</script>

<Menu bind:open bind:anchorPoint placement="bottom-end" minWidth="13rem" label={copy.design.frame.actions}>
  {#snippet trigger(props)}
    <IconButton label={copy.design.frame.actions} size="xs" class="frame-menu" title="" {...props}><MoreHorizontal aria-hidden="true" /></IconButton>
  {/snippet}
  <MenuItem icon={Maximize2} label={copy.design.frame.zoom} onselect={() => designStore.focusFrame(frame.key)} />
  <MenuItem icon={GalleryHorizontal} label={copy.design.frame.variant} onselect={askVariant} />
  {#if frame.variant}
    <MenuItem icon={Check} label={copy.design.variants.use} onselect={() => void designStore.promote(pageLabel(frame.page))} />
  {/if}
  {#if frame.page !== 'index.html'}
    <div class="ui-menu-separator" role="separator"></div>
    <MenuItem icon={Trash2} danger label={frame.variant ? copy.design.frame.removeVariant : copy.design.frame.remove} onselect={() => void remove()} />
  {/if}
</Menu>
