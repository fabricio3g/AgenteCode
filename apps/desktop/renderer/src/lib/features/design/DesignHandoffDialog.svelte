<svelte:options runes={true} />

<!--
  Hand off to Code. The user picks a project and a build target; on confirm
  the design is copied into the project's .agente/designs/ folder and a Code
  conversation opens with the build prompt in its composer. Nothing is sent:
  the user reads the prompt and sends it.
-->

<script lang="ts">
  import DialogActions from '$lib/components/ui/DialogActions.svelte';

  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { Check, FolderOpen } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { invoke } from '$lib/services/bridge';
  import { pickWorkspaceFolder } from '$lib/services/files';
  import type { DesignHandoffResult } from '$shared/design';
  import { designStore } from './design.svelte';
  import { buildHandoffPrompt, buildHandoffSpec, handoffTitle, STACK_PRESETS, stackPhrase } from './design-handoff';

  let { onclose }: { onclose: () => void } = $props();

  const basename = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

  /** A folder picked here stays in the list even though it is not a Code project yet. */
  let picked = $state<string | null>(null);
  let root = $state<string | null>(codeStore.projectById(codeStore.activeProjectId)?.rootPath ?? codeStore.projects[0]?.rootPath ?? null);
  let presetId = $state<string>(STACK_PRESETS[0].id);
  let typed = $state('');
  let busy = $state(false);
  let error = $state('');

  const options = $derived.by(() => {
    const list = codeStore.projects.map((project) => ({ path: project.rootPath, name: project.rootName }));
    if (picked && !list.some((item) => item.path === picked)) list.push({ path: picked, name: basename(picked) });
    return list;
  });
  const stack = $derived(stackPhrase(presetId, typed));
  const presetLabel = (preset: (typeof STACK_PRESETS)[number]) => preset.label ?? copy.design.handoff.dialog.keepHtml;
  /** A typed stack replaces the presets: none of the segments is the choice then. */
  const stackOptions = STACK_PRESETS.map((preset) => ({ value: preset.id, label: presetLabel(preset) }));
  const stackValue = $derived(typed.trim() ? '' : presetId);

  async function choose() {
    const folder = await pickWorkspaceFolder().catch(() => null);
    if (!folder) return;
    picked = folder;
    root = folder;
  }

  async function handOff() {
    const chatId = designStore.chatId;
    const projectRoot = root;
    if (!chatId || !projectRoot || busy) return;
    busy = true;
    error = '';
    const { files, pages } = designStore.data;
    const title = handoffTitle(files, pages);
    try {
      const result = await invoke<DesignHandoffResult>('design_handoff', {
        chatId,
        action: 'deliver',
        title,
        handoff: buildHandoffSpec(designStore.data),
        projectRoot
      });
      if (!('slug' in result)) throw new Error('Unexpected handoff result');
      const project = await codeStore.addProject(projectRoot);
      if (!project) throw new Error('No project');
      codeStore.newConversation(project);
      appStore.updateComposer(buildHandoffPrompt({ title, folder: `.agente/designs/${result.slug}`, stack }));
      window.dispatchEvent(new Event('focus-composer'));
      onclose();
    } catch {
      error = copy.design.handoff.dialog.failed;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog title={copy.design.handoff.dialog.title} description={copy.design.handoff.dialog.description} size="md" {onclose}>
  <div class="body">
    <section>
      <h3>{copy.design.handoff.dialog.project}</h3>
      {#if options.length === 0}
        <p class="hint">{copy.design.handoff.dialog.noProjects}</p>
      {:else}
        <ul class="projects">
          {#each options as option (option.path)}
            <li>
              <UiListRow  type="button" class={uiClass("ui-row project", "ui-local-7e44278c", {"is-selected": root === option.path})}  aria-pressed={root === option.path} title={option.path} onclick={() => (root = option.path)}>
                <span class="name">{option.name}</span>
                <span class="path">{option.path}</span>
                {#if root === option.path}<Check class="mark" aria-hidden="true" />{/if}
              </UiListRow>
            </li>
          {/each}
        </ul>
      {/if}
      <Button variant="ghost" size="sm" class="self-start" onclick={() => void choose()}><FolderOpen aria-hidden="true" />{copy.design.handoff.dialog.choose}</Button>
    </section>

    <section>
      <h3>{copy.design.handoff.dialog.stack}</h3>
      <SegmentedControl label={copy.design.handoff.dialog.stack} options={stackOptions} value={stackValue} onchange={(value) => { presetId = value; typed = ''; }} />
      <Input bind:value={typed} maxlength={80} placeholder={copy.design.handoff.dialog.stackCustom} aria-label={copy.design.handoff.dialog.stack} />
    </section>

    {#if root}
      <p class="summary">{copy.design.handoff.dialog.copies} <code>{root}/.agente/designs/</code></p>
    {:else}
      <p class="hint">{copy.design.handoff.dialog.needProject}</p>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

  {#snippet footer()}
    <DialogActions cancelLabel={copy.design.handoff.dialog.cancel} confirmLabel={copy.design.handoff.dialog.confirm} oncancel={onclose} onconfirm={() => void handOff()} disabled={!root} busy={busy} busyLabel={copy.design.handoff.dialog.working} />
  {/snippet}
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
    padding: 1rem 1.25rem;
    font-size: var(--text-sm);
  }

  section { display: flex; flex-direction: column; gap: 0.5rem; }

  h3 {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted-foreground);
  }

  .hint,
  .summary { margin: 0; color: var(--muted-foreground); line-height: 1.5; }
  .summary code { font-size: var(--text-xs); color: var(--foreground); word-break: break-all; }
  .error { margin: 0; color: var(--error); }

  .projects {
    display: flex;
    max-height: 11rem;
    flex-direction: column;
    gap: 0.125rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  :global(.project.ui-local-7e44278c) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0 0.5rem;
    padding: 0.4375rem 0.625rem;
    font-size: var(--text-sm);
  }

  :global(.project.ui-local-7e44278c) :global(.mark) { width: 0.875rem; height: 0.875rem; color: var(--brand-accent); grid-row: 1 / span 2; grid-column: 2; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path { overflow: hidden; color: var(--muted-foreground); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
</style>
