<svelte:options runes={true} />

<!--
  The menu on a board frame's label: zoom to it, ask the agent for a variant of
  it or for the next screen, link it to another page (flows.json), export it as
  a PNG or its page as a PDF, use a variant, delete a page or variant. It opens from its ⋯ button or,
  through `openAt`, where the label was right-clicked.
-->

<script lang="ts">
  import { ArrowRight, Check, FileImage, FileText, GalleryHorizontal, Link2, Maximize2, MoreHorizontal, Trash2 } from '$lib/icons';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import SubMenu, { submenuGroup } from '$lib/components/ui/SubMenu.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import { designStore } from './design.svelte';
  import { exportRendered } from './design-export';
  import { hasLink } from '$shared/design-flows';
  import { pageLabel, type BoardFrame } from './design-view';

  let { frame }: { frame: BoardFrame } = $props();

  let open = $state(false);
  const group = submenuGroup();
  /** Every other page and variant: where this one can lead. */
  const targets = $derived(designStore.boardPages.filter((page) => page !== frame.page));
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

  /** Puts a request for the screen that follows this one in the composer; the user reads it and sends it. */
  function askNext() {
    designStore.select(frame.page, frame.key);
    appStore.composer = copy.design.frame.nextPrompt.replace('{page}', frame.page);
    if (!designStore.chatOpen) designStore.toggleChat();
    window.dispatchEvent(new Event('focus-composer'));
  }

  async function toggleLink(to: string) {
    try {
      await designStore.toggleLink(frame.page, to);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : copy.design.frame.linkFailed);
    }
  }

  /** Renders in main and saves through a save dialog: the frame's width as a PNG, or the page as a PDF. */
  async function exportAs(kind: 'png' | 'pdf') {
    const chatId = designStore.chatId;
    if (!chatId) return;
    const outcome = await exportRendered(chatId, designStore.data.files, frame.page, kind, frame.width);
    if (outcome === 'failed') toastStore.error(copy.design.export.failed);
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
  <MenuItem icon={ArrowRight} label={copy.design.frame.nextScreen} onselect={askNext} />
  <SubMenu {group} key="link" icon={Link2} label={copy.design.frame.link} disabled={!targets.length}>
    {#each targets as page (page)}
      <MenuItem label={page} active={hasLink(designStore.links, frame.page, page)} onselect={() => void toggleLink(page)} />
    {/each}
  </SubMenu>
  <div class="ui-menu-separator" role="separator"></div>
  <MenuItem icon={FileImage} label={copy.design.export.png} onselect={() => void exportAs('png')} />
  <MenuItem icon={FileText} label={copy.design.export.pdf} onselect={() => void exportAs('pdf')} />
  {#if frame.variant}
    <MenuItem icon={Check} label={copy.design.variants.use} onselect={() => void designStore.promote(pageLabel(frame.page))} />
  {/if}
  {#if frame.page !== 'index.html'}
    <div class="ui-menu-separator" role="separator"></div>
    <MenuItem icon={Trash2} danger label={frame.variant ? copy.design.frame.removeVariant : copy.design.frame.remove} onselect={() => void remove()} />
  {/if}
</Menu>
