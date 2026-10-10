<svelte:options runes={true} />

<!--
  The handoff entries of the Export menu: a zip bundle, the build prompt or
  HANDOFF.md copied for any other tool, and the hand-off to a Code project.
  Nothing here writes into a project; that happens only from the dialog.
-->

<script lang="ts">
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { Copy, FileText, Package, Send } from 'lucide-svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { copy } from '$lib/copy';
  import { invoke } from '$lib/services/bridge';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { designStore } from './design.svelte';
  import { buildHandoffPrompt, buildHandoffSpec, handoffTitle } from './design-handoff';
  import type { DesignHandoffPage, DesignHandoffRequest, DesignHandoffResult } from '$shared/design';

  let { onhandoff, note }: { onhandoff: () => void; note: (message: string) => void } = $props();

  const ready = $derived(designStore.data.pages.length > 0);
  const title = () => handoffTitle(designStore.data.files, designStore.data.pages);
  const spec = () => buildHandoffSpec(designStore.data);

  /** Every page as one self-contained HTML document, the same form Export downloads. */
  function inlinedPages(): DesignHandoffPage[] {
    const { files } = designStore.data;
    const names = [...designStore.data.pages, ...designStore.data.variants.map((variant) => variant.entry)];
    return names.flatMap((name) => {
      const source = files[name];
      if (source === undefined) return [];
      try { return [{ name, html: buildPreviewHtml(source, files, name, true).html }]; } catch { return []; }
    });
  }

  async function copyText(text: string) {
    try {
      if (!await writeToClipboard(text)) throw new Error('Clipboard unavailable');
      note(copy.design.handoff.copied);
    } catch {
      note(copy.design.export.failed);
    }
  }

  async function bundle() {
    const chatId = designStore.chatId;
    if (!chatId) return;
    try {
      const request: DesignHandoffRequest = { chatId, action: 'bundle', title: title(), handoff: spec(), pages: inlinedPages() };
      const result = await invoke<DesignHandoffResult>('design_handoff', request);
      if ('saved' in result && result.saved) note(copy.design.handoff.bundled);
    } catch {
      note(copy.design.export.failed);
    }
  }

  function handOff() {
    onhandoff();
  }
</script>

<MenuItem icon={Package} label={copy.design.handoff.bundle} disabled={!ready} onselect={() => void bundle()} />
<MenuItem icon={Send} label={copy.design.handoff.toCode} disabled={!ready} onselect={handOff} />
<MenuItem icon={Copy} label={copy.design.handoff.copyPrompt} disabled={!ready} onselect={() => void copyText(buildHandoffPrompt({ title: title(), folder: null, handoff: spec() }))} />
<MenuItem icon={FileText} label={copy.design.handoff.copyDoc} disabled={!ready} onselect={() => void copyText(spec())} />
