<svelte:options runes={true} />

<!--
  The design-system actions as menu items: switch the open design's system,
  save it as one, generate a specimen, import from a folder, or manage the
  library. The toolbar's system chip and the More menu both render these.
-->

<script lang="ts">
  import { FolderInput, Library, Save, Sparkles } from 'lucide-svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { designStore } from './design.svelte';
  import { designSystems } from './design-systems.svelte';

  let { onmanage }: { onmanage: () => void } = $props();

  const chatId = $derived(designStore.chatId);
  const current = $derived(designSystems.linked?.id ?? null);

  async function run(action: () => Promise<unknown>, done?: string) {
    try {
      await action();
      if (done) toastStore.success(done);
    } catch (cause) {
      toastStore.error(String(cause));
    }
  }

  function use(id: string | null) {
    if (!chatId) return;
    void run(() => (id ? designSystems.apply(chatId, id) : designSystems.unlink(chatId)), id ? copy.design.systems.applied : undefined);
  }

  async function importFolder() {
    try {
      if (await designSystems.importFolder()) {
        toastStore.success(copy.design.systems.imported);
        onmanage();
      }
    } catch (cause) {
      toastStore.error(String(cause));
    }
  }

  /** A quick prompt in the composer: the agent writes the specimen page, the user sends it. */
  function specimen() {
    appStore.composer = copy.design.systems.specimenPrompt;
    window.dispatchEvent(new Event('focus-composer'));
  }
</script>

<MenuItem label={copy.design.systems.none} active={!current} disabled={!chatId} onselect={() => use(null)} />
{#each designSystems.list as system (system.id)}
  <MenuItem label={system.name} description={system.description || undefined} active={current === system.id} disabled={!chatId} onselect={() => use(system.id)} />
{/each}
<MenuItem icon={Save} label={copy.design.systems.saveAs} disabled={!chatId} onselect={onmanage} />
<MenuItem icon={Sparkles} label={copy.design.systems.specimenAction} disabled={!chatId} onselect={specimen} />
<MenuItem icon={FolderInput} label={copy.design.systems.import} onselect={() => void importFolder()} />
<MenuItem icon={Library} label={copy.design.systems.manage} onselect={onmanage} />
