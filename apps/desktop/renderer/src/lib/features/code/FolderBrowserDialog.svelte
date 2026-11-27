<svelte:options runes={true} />

<!--
  The "Add project" modal, opened by any Add project button through
  `codeStore.addProject()`. Three ways in, one tab each:

  - Open folder: the in-app folder browser (type a path with the pencil or Ctrl+L).
  - New folder: a name and where it goes; main creates it and runs `git init`.
  - Clone: a repository URL; main clones it into the chosen folder.

  New and Clone share one "where" line — the projects folder, remembered per
  viewer — and say exactly what they will make before you press the button
  ("Creates ~/Code/my-app"). The summary sits on the footer's left edge and
  the one action on its right; a problem replaces the summary in red, so the
  line under the fields always answers "what happens if I press this".
-->

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Button, Checkbox, Dialog, Input, SegmentedControl } from '$lib/components/ui';
  import { FolderOpen, FolderPlus, GitBranch, LoaderCircle } from '$lib/icons';
  import { browseFolders, cloneProjectRepo, createProjectFolder, pickWorkspaceFolder } from '$lib/services/files';
  import { cleanIpcError } from '$lib/utils/errors';
  import { toErrorMessage } from '$shared/errors';
  import { cloneUrlProblem, folderNameProblem, repoNameFromUrl } from '$shared/project-setup';
  import { codeStore } from './code.svelte';
  import FolderBrowser from './FolderBrowser.svelte';
  import { defaultProjectsRoot, joinPath, readRemembered, remember, shortPath } from './add-project';

  type Mode = 'open' | 'new' | 'clone';
  let mode = $state<Mode>('open');
  // Each opening starts on the tab its caller asked for (the Code empty
  // state's three ways in); switching tabs afterwards is the reader's own.
  $effect(() => {
    if (codeStore.folderBrowserOpen) mode = codeStore.folderBrowserMode;
  });

  let home = $state('');
  let root = $state('');
  let changingRoot = $state(false);

  let name = $state('');
  let gitInit = $state(true);
  let url = $state('');
  let cloneName = $state('');

  let busy = $state(false);
  let failure = $state('');
  /** A field is only judged once it has been typed into or submitted. */
  let touched = $state(false);
  let firstField = $state<HTMLInputElement>();

  onMount(async () => {
    try {
      const listing = await browseFolders();
      home = listing.home;
      root = defaultProjectsRoot(listing, readRemembered());
    } catch {
      root = readRemembered() ?? '';
    }
  });

  const options = $derived([
    { value: 'open', label: $t('code.addProjectFlow.open'), icon: FolderOpen },
    { value: 'new', label: $t('code.addProjectFlow.new'), icon: FolderPlus },
    { value: 'clone', label: $t('code.addProjectFlow.clone'), icon: GitBranch }
  ]);

  const derivedCloneName = $derived(repoNameFromUrl(url));
  const folder = $derived(mode === 'new' ? name.trim() : (cloneName.trim() || derivedCloneName));
  const problem = $derived.by(() => {
    if (mode === 'clone') {
      const urlProblem = cloneUrlProblem(url);
      if (urlProblem) return urlProblem;
    }
    return folderNameProblem(folder);
  });
  const target = $derived(root && folder ? joinPath(root, folder) : '');

  async function switchTo(next: string) {
    mode = next as Mode;
    failure = '';
    touched = false;
    changingRoot = false;
    await tick();
    firstField?.focus();
  }

  async function submit() {
    touched = true;
    if (problem || !root || busy) return;
    busy = true;
    failure = '';
    try {
      const made = mode === 'new'
        ? await createProjectFolder(root, folder, gitInit)
        : await cloneProjectRepo(url.trim(), root, cloneName.trim() || undefined);
      remember(root);
      codeStore.resolveFolderBrowser(made.path);
    } catch (error) {
      failure = cleanIpcError(toErrorMessage(error));
    } finally {
      busy = false;
    }
  }

  async function chooseRootWithSystem() {
    const picked = await pickWorkspaceFolder().catch(() => null);
    if (picked) { root = picked; changingRoot = false; }
  }

  function close() {
    if (!busy) codeStore.resolveFolderBrowser(null);
  }
</script>

{#if codeStore.folderBrowserOpen}
  <Dialog title={$t('code.addProject')} description={$t('code.noProjectsHint')} size="lg" dismissible={!busy} onclose={close}>
    <div class="add-project">
      <div class="modes">
        <SegmentedControl label={$t('code.addProject')} {options} value={mode} variant="tabs" shape="soft" class="border-0 bg-transparent p-0" onchange={(value) => void switchTo(value)} />
      </div>

      {#if mode === 'open'}
        <FolderBrowser embedded onopen={(path) => codeStore.resolveFolderBrowser(path)} onsystem={() => void codeStore.pickWithSystemDialog()} />
      {:else if changingRoot}
        <FolderBrowser embedded choose start={root || undefined} onopen={(path) => { root = path; changingRoot = false; }} onsystem={() => void chooseRootWithSystem()} />
      {:else}
        <form class="form" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
          {#if mode === 'clone'}
            <label class="field">
              <span class="label">{$t('code.addProjectFlow.url')}</span>
              <Input bind:ref={firstField} bind:value={url} placeholder="https://github.com/owner/repo" spellcheck="false" autocomplete="off" disabled={busy} oninput={() => (failure = '')} />
            </label>
            <label class="field">
              <span class="label">{$t('code.addProjectFlow.folderName')}</span>
              <Input bind:value={cloneName} placeholder={derivedCloneName || $t('code.addProjectFlow.namePlaceholder')} spellcheck="false" autocomplete="off" disabled={busy} oninput={() => (failure = '')} />
            </label>
          {:else}
            <label class="field">
              <span class="label">{$t('code.addProjectFlow.name')}</span>
              <Input bind:ref={firstField} bind:value={name} placeholder={$t('code.addProjectFlow.namePlaceholder')} spellcheck="false" autocomplete="off" disabled={busy} oninput={() => { failure = ''; touched = true; }} />
            </label>
          {/if}

          <div class="where">
            <span class="label">{$t('code.addProjectFlow.location')}</span>
            <span class="where-path" title={root}>{shortPath(root, home) || '…'}</span>
            <Button variant="ghost" size="sm" type="button" disabled={busy} onclick={() => (changingRoot = true)}>{$t('code.addProjectFlow.change')}</Button>
          </div>

          {#if mode === 'new'}
            <label class="check">
              <Checkbox bind:checked={gitInit} disabled={busy} />
              <span>{$t('code.addProjectFlow.gitInit')}</span>
            </label>
          {/if}

          <div class="footer">
            {#if failure}
              <p class="summary is-error" role="alert">{failure}</p>
            {:else if touched && problem}
              <p class="summary is-error">{$t(`code.addProjectFlow.problem.${problem}`)}</p>
            {:else if busy && mode === 'clone'}
              <p class="summary"><LoaderCircle class="spin" />{$t('code.addProjectFlow.cloning', { values: { url: url.trim() } })}</p>
            {:else if target && !problem}
              <p class="summary">{$t(mode === 'new' ? 'code.addProjectFlow.creates' : 'code.addProjectFlow.clonesInto', { values: { path: shortPath(target, home) } })}</p>
            {:else}
              <p class="summary"></p>
            {/if}
            <Button size="sm" type="submit" disabled={busy || !root || (touched && !!problem)}>
              {mode === 'new' ? $t('code.addProjectFlow.create') : busy ? $t('code.addProjectFlow.cloningShort') : $t('code.addProjectFlow.cloneAction')}
            </Button>
          </div>
        </form>
      {/if}
    </div>
  </Dialog>
{/if}

<style>
  .add-project { display: flex; flex-direction: column; min-width: 0; }
  /* The tabs sit on the dialog itself: no track box, the active tab is the lit one. */
  .modes { padding: 0 0.75rem 0.25rem; }
  /* As tall as the folder browser, footer on the bottom edge, so switching tabs never moves the dialog. */
  .form { display: flex; flex-direction: column; gap: 0.875rem; height: min(27rem, 62vh); padding: 0.75rem 1rem 0.75rem; }
  .field { display: grid; gap: 0.375rem; }
  .label { font-size: var(--text-xs); font-weight: 500; color: var(--muted-foreground); }
  /* Label hard left, the path beside it, Change hard right. */
  .where { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
  .where .label { flex-shrink: 0; }
  .where-path { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--foreground); }
  .check { display: flex; align-items: center; gap: 0.5rem; font-size: var(--text-sm); color: var(--foreground); cursor: pointer; }
  .footer { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; min-height: 2rem; margin-top: auto; padding-top: 0.25rem; }
  .summary { display: flex; align-items: center; gap: 0.375rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--muted-foreground); }
  .summary.is-error { color: var(--error); white-space: normal; }
  .summary :global(.spin) { width: 0.875rem; height: 0.875rem; flex-shrink: 0; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
