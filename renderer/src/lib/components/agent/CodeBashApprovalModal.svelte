<svelte:options runes={true} />

<script lang="ts">
  import { Terminal, Check, X, Shield } from 'lucide-svelte';
  import { resolveApproval } from '$lib/stores/approvals.svelte';
  import type { PendingApproval } from '$lib/stores/approvals.svelte';

  interface Props {
    approval: PendingApproval;
  }

  let { approval }: Props = $props();

  function allow() {
    resolveApproval(approval.id, true);
  }

  function deny() {
    resolveApproval(approval.id, false);
  }

  function onBackdropKey(event: KeyboardEvent) {
    if (event.key === 'Escape') deny();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="aui-modal-backdrop z-[500]"
  role="dialog"
  aria-modal="true"
  aria-labelledby="code-approval-title"
  tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) deny(); }}
  onkeydown={onBackdropKey}
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="aui-modal-surface max-w-md" onclick={(e) => e.stopPropagation()}>
    <div class="aui-modal-header">
      <div class="flex items-center gap-2.5">
        <div class="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Shield class="size-4" />
        </div>
        <h2 id="code-approval-title" class="aui-modal-title">Command approval</h2>
      </div>
      <button type="button" class="aui-icon-button size-8" onclick={deny} aria-label="Deny">
        <X class="size-4" />
      </button>
    </div>

    <div class="aui-modal-body !pt-0 space-y-3">
      <p class="m-0 text-xs text-muted-foreground">Supervised mode needs your OK before running this shell command.</p>
      <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Terminal class="size-3.5" />
        <span>Command</span>
      </div>
      <pre class="m-0 max-h-40 overflow-auto rounded-md bg-muted px-3 py-2.5 font-mono text-xs text-foreground whitespace-pre-wrap break-all">{approval.command}</pre>
      {#if approval.cwd}
        <p class="m-0 truncate font-mono text-[0.7rem] text-muted-foreground" title={approval.cwd}>in: {approval.cwd}</p>
      {/if}
    </div>

    <div class="aui-modal-footer">
      <button type="button" class="aui-btn aui-btn-ghost gap-1.5" onclick={deny}>
        <X class="size-3.5" />
        Deny
      </button>
      <button type="button" class="aui-btn aui-btn-primary gap-1.5" onclick={allow}>
        <Check class="size-3.5" />
        Allow
      </button>
    </div>
  </div>
</div>
