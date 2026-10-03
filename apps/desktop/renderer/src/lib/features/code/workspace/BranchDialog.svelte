<svelte:options runes={true} />

<!--
  "New branch": one name, created from the current HEAD.

  git's own ref rules decide what is valid, so the field only refuses to submit
  an empty name; an invalid one comes back from the switch as git's message.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Button, Dialog, Input } from '$lib/components/ui';

  let {
    projectRoot,
    busy = false,
    oncreate,
    onclose
  }: {
    projectRoot: string;
    busy?: boolean;
    oncreate: (name: string) => void;
    onclose: () => void;
  } = $props();

  let name = $state('');

  function submit() {
    if (!busy && name.trim()) oncreate(name.trim());
  }
</script>

<Dialog title={$t('codeWs.newBranch')} description={$t('codeWs.newBranchHint')} {onclose} size="sm">
  <div class="p-4">
    <Input
      bind:value={name}
      placeholder={$t('codeWs.branchName')}
      aria-label={$t('codeWs.branchName')}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      }}
    />
    <p class="mt-2 text-[12px] text-muted-foreground">{$t('codeWs.newBranchFrom', { values: { root: projectRoot } })}</p>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>{$t('codeWs.cancel')}</Button>
    <Button disabled={busy || !name.trim()} onclick={submit}>{$t('codeWs.createBranch')}</Button>
  {/snippet}
</Dialog>
