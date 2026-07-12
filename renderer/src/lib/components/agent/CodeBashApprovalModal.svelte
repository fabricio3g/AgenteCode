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
</script>

<div class="approval-backdrop" onclick={deny} onkeydown={(e) => { if (e.key === 'Escape') deny(); }}>
  <div class="approval-card" onclick={(e) => e.stopPropagation()}>
    <header class="approval-header">
      <Shield class="h-4 w-4" />
      <span>Command approval requested</span>
    </header>
    <div class="approval-body">
      <div class="approval-label">
        <Terminal class="h-3.5 w-3.5" />
        <span>Command</span>
      </div>
      <pre class="approval-command">{approval.command}</pre>
      <div class="approval-cwd">in: {approval.cwd}</div>
    </div>
    <footer class="approval-footer">
      <button type="button" class="approval-btn secondary" onclick={deny}>
        <X class="h-3.5 w-3.5" />
        <span>Deny</span>
      </button>
      <button type="button" class="approval-btn primary" onclick={allow}>
        <Check class="h-3.5 w-3.5" />
        <span>Allow</span>
      </button>
    </footer>
  </div>
</div>

<style>
  .approval-backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--overlay, #000) 45%, transparent);
  }

  .approval-card {
    width: min(90vw, 32rem);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--background);
    box-shadow: var(--shadow-lg);
  }

  .approval-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-bottom: none;
    padding: 0.875rem 1.1rem 0.35rem;
    color: var(--warning, #d97706);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .approval-body {
    padding: 0.8rem 0.9rem;
  }

  .approval-label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.4rem;
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .approval-command {
    margin: 0;
    border: none;
    border-radius: var(--radius-md);
    background: var(--muted);
    color: var(--foreground);
    padding: 0.65rem 0.75rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 10rem;
    overflow: auto;
  }

  .approval-cwd {
    margin-top: 0.4rem;
    color: var(--text-muted);
    font-size: 0.68rem;
    font-family: var(--font-mono);
  }

  .approval-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    border-top: none;
    padding: 0.65rem 1.1rem 1rem;
  }

  .approval-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    height: 2.2rem;
    border-radius: 0.6rem;
    padding: 0 0.85rem;
    font-size: 0.8rem;
    font-weight: 720;
    cursor: pointer;
    transition: opacity 0.12s ease;
  }

  .approval-btn:hover {
    opacity: 0.85;
  }

  .approval-btn.primary {
    border: 0;
    background: var(--primary);
    color: var(--primary-fg);
  }

  .approval-btn.secondary {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-secondary);
  }
</style>
