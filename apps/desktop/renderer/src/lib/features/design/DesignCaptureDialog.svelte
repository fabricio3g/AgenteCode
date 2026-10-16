<svelte:options runes={true} />

<!--
  Capture a website: a public address, and main saves a screenshot of the page
  into references/. Main opens it in a private window that can reach public
  http(s) addresses only; nothing from the page comes back but the picture.
-->

<script lang="ts">
  import DialogActions from '$lib/components/ui/DialogActions.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { copy } from '$lib/copy';
  import { designStore } from './design.svelte';
  import { normalizeSiteUrl } from './design-references';

  let { onclose }: { onclose: () => void } = $props();

  let address = $state('');
  let busy = $state(false);
  let error = $state('');

  async function capture() {
    if (busy) return;
    const url = normalizeSiteUrl(address);
    if (!url) { error = copy.design.references.siteInvalid; return; }
    busy = true;
    error = '';
    try {
      const result = await designStore.captureSite(url);
      if (result.ok) { onclose(); return; }
      error = result.error || copy.design.references.siteFailed;
    } catch {
      error = copy.design.references.siteFailed;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog title={copy.design.references.siteTitle} description={copy.design.references.siteDescription} size="sm" {onclose}>
  <div class="body">
    <Field label={copy.design.references.siteLabel}>
      <Input
        autofocus
        bind:value={address}
        placeholder={copy.design.references.sitePlaceholder}
        aria-label={copy.design.references.siteLabel}
        onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void capture(); } }}
      />
    </Field>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

  {#snippet footer()}
    <DialogActions cancelLabel={copy.design.references.siteCancel} confirmLabel={copy.design.references.siteConfirm} oncancel={onclose} onconfirm={() => void capture()} disabled={!address.trim()} {busy} busyLabel={copy.design.references.siteWorking} />
  {/snippet}
</Dialog>

<style>
  .body { display: flex; flex-direction: column; gap: 0.75rem; padding: 1rem 1.25rem; font-size: var(--text-sm); }
  .error { margin: 0; color: var(--destructive); font-size: var(--text-xs); }
</style>
