<svelte:options runes={true} />

<!--
  The one place a run asks you something: a tool call held for your answer,
  on top of the prompt sheet where your hands already are. Code and the chat
  composer (Home, Design, Roleplay) both mount it.

  It used to be the generic question picker — a title, the raw command in
  mono, then "Allow" and "Deny" as two bare rows — so it read as a menu and
  said nothing about what was at stake. Now it is one line of decision:

    [glyph]  Allow this edit?                           Deny Esc   Allow ↵
             src/index.ts  +1 −1

  The question names the kind of call, the subject is the file or command it
  touches (a click scrolls to its diff in the conversation), and the two
  buttons carry their keys. A destructive call says so in red. The transcript
  shows the diff; it no longer carries a second pair of buttons. A `service`
  request (a connected app's action, a local creative domain) has no file or
  command to name, so it asks "Allow this action?" over the action itself.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { FilePen, ListChecks, ShieldAlert, SquareTerminal, Wrench } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import type { PendingApproval } from '$lib/stores/approvals.svelte';
  import type { AgentStep } from '$lib/types/chat';
  import { copy } from '$lib/copy';
  import { titleCaseToolName } from '$lib/utils/tool-ui';
  import { toolKind } from '$shared/tool-kinds';
  import { formatShortcut } from '$lib/utils/shortcuts';

  let {
    approval,
    step,
    index = 1,
    total = 1,
    service = false,
    onanswer
  }: {
    approval: PendingApproval;
    /** The transcript's row for this request, when there is one: it holds the diff. */
    step?: AgentStep;
    /** Which of the pending requests this is (1-based), when several wait. */
    index?: number;
    total?: number;
    /** A connected service's action rather than a coding tool call. */
    service?: boolean;
    onanswer: (allow: boolean) => void;
  } = $props();

  const PLAN = /^Approve plan\s*—\s*/;

  /** "edit src/index.ts" → the tool and what it touches. */
  const parsed = $derived.by(() => {
    if (service) return { kind: 'action' as const, tool: '', subject: approval.command };
    if (PLAN.test(approval.command)) return { kind: 'plan' as const, tool: '', subject: approval.command.replace(PLAN, '') };
    const [tool = '', ...rest] = approval.command.trim().split(/\s+/);
    const kind = toolKind(tool);
    return { kind: kind === 'edit' || kind === 'command' ? kind : ('other' as const), tool, subject: rest.join(' ') };
  });

  const title = $derived(
    parsed.kind === 'other'
      ? $t('code.approve.other', { values: { tool: titleCaseToolName(parsed.tool || 'tool') } })
      : $t(`code.approve.${parsed.kind}`)
  );
  /** Where a service request acts (the connected app, the creative project). */
  const where = $derived(service && approval.cwd && !approval.command.startsWith(approval.cwd) ? approval.cwd : '');
  const Icon = $derived(approval.dangerous ? ShieldAlert : parsed.kind === 'edit' ? FilePen : parsed.kind === 'command' ? SquareTerminal : parsed.kind === 'plan' ? ListChecks : Wrench);

  /** What an edit would change, counted from the diff the row shows. */
  const churn = $derived.by(() => {
    const lines = (step?.detail ?? '').split('\n');
    if (!lines.some((line) => line.startsWith('+++') || line.startsWith('@@'))) return null;
    const adds = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
    const dels = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
    return adds || dels ? { adds, dels } : null;
  });

  /** The diff waits in the conversation: bring it into view. */
  function reveal() {
    const bands = document.querySelectorAll<HTMLElement>('.step-inner.is-approval');
    bands[bands.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /*
   * Keys from the window, never from inside a field: Enter in the prompt is a
   * message. The composer answers for its own field (an empty one), so the
   * keys work wherever the caret is.
   */
  function onKeydown(event: KeyboardEvent) {
    const target = event.target;
    if (target instanceof Element && target.closest('textarea, input, select, [contenteditable="true"]')) return;
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onanswer(true); }
    else if (event.key === 'Escape') { event.preventDefault(); onanswer(false); }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="frame">
<div class="approval" class:is-danger={approval.dangerous} role="group" aria-label={title}>
  <span class="glyph" aria-hidden="true"><Icon class="size-4" /></span>

  <div class="text">
    <p class="title">
      {title}
      {#if total > 1}<span class="count">{$t('code.approve.of', { values: { n: index, total } })}</span>{/if}
    </p>
    {#if parsed.subject || churn}
      <p class="subject">
        {#if parsed.subject && service}
          <span class="target is-static">{parsed.subject}</span>
          {#if where}<span class="where">{where}</span>{/if}
        {:else if parsed.subject}
          <button type="button" class="target" title={$t('code.approve.show')} onclick={reveal}>{parsed.subject}</button>
        {/if}
        {#if churn}<span class="churn"><span class="text-success">+{churn.adds}</span><span class="text-error">−{churn.dels}</span></span>{/if}
      </p>
    {/if}
    {#if approval.dangerous}<p class="note is-danger">{copy.tool.approvalDestructive}</p>{/if}
    {#if approval.reason}<p class="note">{approval.reason}</p>{/if}
  </div>

  <div class="actions">
    <Button variant="ghost" size="sm" onclick={() => onanswer(false)}>
      {copy.tool.deny}<kbd>{formatShortcut('escape')}</kbd>
    </Button>
    <Button variant={approval.dangerous ? 'destructive' : 'default'} size="sm" onclick={() => onanswer(true)}>
      {copy.tool.allow}<kbd>{formatShortcut('enter')}</kbd>
    </Button>
  </div>
</div>
</div>

<style>
  /* Sized by the sheet, so a narrow pane can fold the answers under the question. */
  .frame {
    container-type: inline-size;
  }
  /* The top of the same sheet the field belongs to: one tinted band, no second
     ring. Amber marks "waiting on you"; red replaces it for a destructive call. */
  .approval {
    --tone: var(--warning);
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    margin: 0.4375rem 0.4375rem 0;
    padding: 0.625rem 0.625rem 0.625rem 0.75rem;
    border-radius: 0.875rem;
    background: color-mix(in srgb, var(--tone) 7%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 18%, transparent);
    animation: approval-in var(--motion-normal) var(--motion-ease-out) both;
  }
  .approval.is-danger {
    --tone: var(--error);
  }
  .glyph {
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--tone) 14%, transparent);
    color: var(--tone);
  }
  .text {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.125rem;
    padding-top: 0.0625rem;
  }
  .title {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: 1.4;
  }
  .count {
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .subject {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 0.625rem;
    margin: 0;
  }
  .target {
    min-width: 0;
    overflow: hidden;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  /* A service action reads as a sentence ("Gmail · Send email to …"), not code. */
  .target.is-static {
    font-family: inherit;
    cursor: default;
  }
  .where {
    flex-shrink: 0;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .target:not(.is-static):hover {
    color: var(--foreground);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .churn {
    display: inline-flex;
    flex-shrink: 0;
    gap: 0.375rem;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .note {
    margin: 0.125rem 0 0;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    line-height: 1.45;
  }
  .note.is-danger {
    color: var(--error);
  }
  .actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding-top: 0.125rem;
  }
  /* The key each answer is bound to, inside its button: read once, then known. */
  .actions kbd {
    margin-left: 0.5rem;
    padding: 0;
    border: 0;
    background: none;
    box-shadow: none;
    color: inherit;
    font-family: inherit;
    font-size: var(--text-xs);
    font-weight: 400;
    opacity: 0.55;
  }
  /* Narrow sheet: the answers drop under the question instead of squeezing it. */
  @container (max-width: 32rem) {
    .approval { flex-wrap: wrap; }
    .actions { width: 100%; justify-content: flex-end; }
  }
  @keyframes approval-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .approval { animation: none; }
  }
</style>
