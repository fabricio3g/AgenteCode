<svelte:options runes={true} />

<!--
  Shared composer dock + 28px-radius `--composer-radius` pill shell used by
  both `CodeComposer.svelte` and `Composer.svelte` (Home, Design, Roleplay).

  Owns the dock fade, centered `--thread-width` frame, `DictationSetupPopover`,
  `ApprovalBar`, recorder vs textarea+send body, and the tray below the shell.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';
  import type { AgentStep } from '$lib/types/chat';
  import type { PendingApproval } from '$lib/stores/approvals.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import type { PendingUserInput } from '$lib/stores/user-inputs.svelte';
  import { userInputsStore } from '$lib/stores/user-inputs.svelte';
  import { appearanceStore } from '$lib/stores/appearance.svelte';
  import type { Dictation } from '$lib/features/chat/composer/use-dictation.svelte';
  import DictationSetupPopover from '$lib/features/chat/composer/DictationSetupPopover.svelte';
  import ComposerRecorder from '$lib/features/chat/composer/ComposerRecorder.svelte';
  import ApprovalBar from './ApprovalBar.svelte';
  import QuestionBar from './QuestionBar.svelte';
  import SendButton from './SendButton.svelte';

  let {
    ariaLabel,
    dockClass = '',
    dockFade = 'compact',
    dictation,
    voiceMode = false,
    running,
    value,
    placeholder,
    grown,
    textarea = $bindable<HTMLTextAreaElement | undefined>(undefined),
    textareaClass = '',
    ariaControls,
    ariaActivedescendant,
    sendDisabled,
    sendLabel,
    stopLabel,
    stopShortcut,
    dictationSlot,
    pendingApprovals,
    pendingInputs = [],
    approvalStep,
    approvalService = false,
    bodyClass = '',
    onpaste,
    ondrop,
    ondragover,
    ondragleave,
    oninput,
    onkeydown,
    onselect,
    onsend,
    onstop,
    dockOverlay,
    beforeShell,
    shellTop,
    tray,
    afterTray
  }: {
    ariaLabel: string;
    dockClass?: string;
    dockFade?: 'compact' | 'tall';
    dictation: Dictation;
    voiceMode?: boolean;
    running: boolean;
    value: string;
    placeholder: string;
    grown: boolean;
    textarea?: HTMLTextAreaElement | undefined;
    textareaClass?: string;
    ariaControls?: string;
    ariaActivedescendant?: string;
    sendDisabled: boolean;
    sendLabel: string;
    stopLabel: string;
    stopShortcut?: 'escape';
    dictationSlot?: { label: string; onclick: () => void; glyph?: Snippet };
    pendingApprovals: PendingApproval[];
    pendingInputs?: PendingUserInput[];
    approvalStep?: (requestId: string) => AgentStep | undefined;
    approvalService?: boolean;
    bodyClass?: string;
    onpaste?: (event: ClipboardEvent) => void;
    ondrop?: (event: DragEvent) => void;
    ondragover?: (event: DragEvent) => void;
    ondragleave?: (event: DragEvent) => void;
    oninput: (event: Event) => void;
    onkeydown: (event: KeyboardEvent) => void;
    onselect?: () => void;
    onsend: () => void;
    onstop: () => void;
    dockOverlay?: Snippet;
    beforeShell?: Snippet;
    shellTop?: Snippet;
    tray?: Snippet;
    afterTray?: Snippet;
  } = $props();

  const recorderActive = $derived(dictation.uiActive && !voiceMode && dictation.phase !== 'choose');
  const composerStyle = $derived(appearanceStore.prefs.composerStyle);
  const integratedTray = $derived(appearanceStore.integratedComposer && !!tray);
  const sendInFooter = $derived(integratedTray && (composerStyle === 'pill' || composerStyle === 'card'));
</script>

<div
  class={uiClass('composer-dock relative z-20 w-full shrink-0 px-3 pb-2 pt-2 md:px-6 md:pb-3', dockFade === 'tall' ? 'fade-tall' : 'fade-compact', dockClass)}
  role="region"
  aria-label={ariaLabel}
  {onpaste}
  {ondrop}
  {ondragover}
  {ondragleave}
>
  {@render dockOverlay?.()}

  <div class="composer-frame mx-auto w-full" style="max-width: var(--thread-width);">
    {#if dictation.phase === 'choose'}
      <DictationSetupPopover {dictation} />
    {/if}

    {@render beforeShell?.()}

    <div class="composer-shell ui-composer pointer-events-auto transition">
      {#if pendingApprovals.length}
        {@const approval = pendingApprovals[0]!}
        <ApprovalBar
          {approval}
          step={approvalStep?.(approval.requestId)}
          service={approvalService}
          total={pendingApprovals.length}
          onanswer={(answer) => approvalsStore.resolve(approval.id, answer)}
        />
      {:else if pendingInputs.length}
        {@const input = pendingInputs[0]!}
        <QuestionBar
          {input}
          total={pendingInputs.length}
          onanswer={(resolution) => userInputsStore.resolve(input.id, resolution)}
        />
      {/if}

      {@render shellTop?.()}

      <div class={uiClass('composer-body', bodyClass)}>
        {#if recorderActive}
          <div class="composer-recorder-row">
            <ComposerRecorder {dictation} />
            {#if running}
              <SendButton
                compact
                {stopShortcut}
                running={true}
                disabled={false}
                {sendLabel}
                {stopLabel}
                {onsend}
                {onstop}
              />
            {/if}
          </div>
        {:else}
          <div class="composer-input-row" class:is-grown={grown} class:has-footer-send={sendInFooter}>
            {#if composerStyle === 'terminal'}
              <span class="composer-terminal-prompt" aria-hidden="true">›</span>
            {/if}
            <UiTextarea
              variant="composer"
              bind:ref={textarea}
              class={uiClass('composer-textarea w-full resize-none bg-transparent text-foreground outline-none', textareaClass)}
              {placeholder}
              rows={1}
              {value}
              aria-controls={ariaControls}
              aria-activedescendant={ariaActivedescendant}
              {oninput}
              {onkeydown}
              {onselect}
            ></UiTextarea>
            {#if !sendInFooter}
              <div class="composer-send-slot">
                <SendButton
                  compact
                  {stopShortcut}
                  {running}
                  disabled={sendDisabled}
                  dictation={dictationSlot}
                  {sendLabel}
                  {stopLabel}
                  {onsend}
                  {onstop}
                />
              </div>
            {/if}
          </div>
        {/if}
      </div>

      {#if !recorderActive && integratedTray && tray}
        <div class="composer-shell-footer" class:has-send={sendInFooter}>
          <div class="composer-tray is-integrated">
            {@render tray()}
          </div>
          {#if sendInFooter}
            <div class="composer-send-slot">
              <SendButton
                compact
                {stopShortcut}
                {running}
                disabled={sendDisabled}
                dictation={dictationSlot}
                {sendLabel}
                {stopLabel}
                {onsend}
                {onstop}
              />
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if !recorderActive && !integratedTray && tray}
      <div class="composer-tray">
        {@render tray()}
      </div>
    {/if}

    {@render afterTray?.()}
  </div>
</div>

<style>
  .composer-dock {
    background: var(--chat-bg);
  }
  .composer-dock::before {
    content: '';
    position: absolute;
    inset-inline: 0;
    pointer-events: none;
  }
  .composer-dock.fade-compact::before {
    top: calc(-1 * var(--dock-gap, 8px));
    height: var(--dock-gap, 8px);
    background: linear-gradient(
      to bottom,
      transparent,
      color-mix(in srgb, var(--chat-bg) 72%, transparent) 58%,
      var(--chat-bg)
    );
  }
  .composer-dock.fade-tall::before {
    top: -2rem;
    height: 2rem;
    background: linear-gradient(
      to bottom,
      transparent,
      color-mix(in srgb, var(--chat-bg) 62%, transparent) 65%,
      var(--chat-bg)
    );
  }
  .composer-frame {
    position: relative;
    min-width: 0;
  }
  .composer-dock.pointer-events-none .composer-frame > :global(*) {
    pointer-events: auto;
  }
</style>
