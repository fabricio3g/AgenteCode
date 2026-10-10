<svelte:options runes={true} />

<!--
  The right-hand pane: the selected element and quick changes that go to the
  chat, the design's tokens (edited in place in tokens.css), and the selected
  page's source. It keeps the Code panes' chrome: a header row with the title
  and a close button, then the tabs, then the body. Its width and its inline or
  sheet placement come from DesignSurface.
-->

<script lang="ts">
  import { writeToClipboard } from '$lib/utils/clipboard';
  import UiColorInput from '$lib/components/ui/ColorInput.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { AlignVerticalSpaceAround, Check, Copy, GalleryHorizontal, Sparkles, X } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { invoke } from '$lib/services/bridge';
  import { isColorValue, colorToHex, parseTokens, tokenEdit, tokensFor, type TokenDecl, type TokenGroup } from './design-tokens';
  import { curvePath, durationMs, EASING_PRESETS, formatDurationToken } from './design-motion';
  import { designStore } from './design.svelte';
  import type { DesignSelection, DesignToolResult } from '$shared/design';

  type Tab = 'element' | 'tokens' | 'code';
  let tab = $state<Tab>('element');
  let error = $state('');
  let copied = $state(false);
  let codeFile = $state('');

  const TOKENS_FILE = 'tokens.css';
  const css = $derived(designStore.data.files[TOKENS_FILE] ?? '');
  const decls = $derived(parseTokens(css));
  const lightTokens = $derived(tokensFor(decls, 'light'));
  const darkTokens = $derived(tokensFor(decls, 'dark'));
  const groups: TokenGroup[] = ['color', 'space', 'radius', 'font', 'shadow', 'motion', 'other'];
  const groupLabel: Record<TokenGroup, string> = $derived({
    color: copy.design.inspector.colors,
    space: copy.design.inspector.space,
    radius: copy.design.inspector.radius,
    font: copy.design.inspector.type,
    shadow: copy.design.inspector.shadow,
    motion: copy.design.inspector.motion,
    other: copy.design.inspector.other
  });

  const easingOptions = $derived(EASING_PRESETS.map((preset) => ({ value: preset.value, label: copy.design.motion.presets[preset.id] })));
  /** An easing the presets do not name keeps its own value as a first option, so the select shows what the token is. */
  const easingChoices = (decl: TokenDecl) => (easingOptions.some((option) => option.value === decl.value.trim())
    ? easingOptions
    : [{ value: decl.value.trim(), label: copy.design.motion.custom }, ...easingOptions]);

  const tabOptions = $derived([
    { value: 'element', label: copy.design.inspector.element },
    { value: 'tokens', label: copy.design.inspector.tokens },
    { value: 'code', label: copy.design.inspector.code }
  ]);

  /** Which of the selection the block shows; it falls back to the first when that pick is gone. */
  let shownId = $state<string | null>(null);
  const element = $derived<DesignSelection | null>(designStore.selection.find((pick) => pick.id === shownId) ?? designStore.selection[0] ?? null);
  /** The element's selector adds to its tag only when it says more than the tag does (`h1` under `<h1>` says nothing new). */
  const showSelector = $derived(!!element && element.selector.toLowerCase() !== element.tag.toLowerCase());

  /** Moves the block to the next selected element, wrapping after the last. */
  function cycleElement() {
    const list = designStore.selection;
    if (list.length < 2 || !element) return;
    shownId = list[(list.indexOf(element) + 1) % list.length].id;
  }

  const quickChanges = [
    { id: 'prominent', icon: Sparkles, label: copy.design.inspector.prominent, prompt: 'Make the selected element more prominent.' },
    { id: 'tighten', icon: AlignVerticalSpaceAround, label: copy.design.inspector.tighten, prompt: 'Tighten the spacing around the selected element.' },
    { id: 'variants', icon: GalleryHorizontal, label: copy.design.inspector.variants, prompt: 'Try three variants of the selected element, as separate pages under variants/.' }
  ];

  const codeFiles = $derived.by(() => {
    const names = [designStore.selected, TOKENS_FILE, 'DESIGN.md'].filter((name) => name && designStore.data.files[name] !== undefined);
    return [...new Set(names)];
  });
  const activeCodeFile = $derived(codeFiles.includes(codeFile) ? codeFile : (codeFiles[0] ?? ''));
  const source = $derived(designStore.data.files[activeCodeFile] ?? '');

  function quick(prompt: string) {
    appStore.composer = prompt;
    window.dispatchEvent(new Event('focus-composer'));
  }

  async function copySource() {
    try {
      if (!await writeToClipboard(source)) return;
      copied = true;
      setTimeout(() => { copied = false; }, 1500);
    } catch { /* clipboard refused; the text is still selectable */ }
  }

  /** One token edit: the declaration is rewritten in place, and main's change event refreshes the canvas. */
  async function commit(decl: TokenDecl, value: string) {
    const chatId = designStore.chatId;
    const text = designStore.data.files[TOKENS_FILE];
    if (!chatId || text === undefined) return;
    const edit = tokenEdit(text, decl, value);
    if (!edit || edit.old_text === edit.new_text) return;
    error = '';
    try {
      const result = await invoke<DesignToolResult>('design_tool', {
        chatId,
        name: 'design_edit',
        args: { path: TOKENS_FILE, old_text: edit.old_text, new_text: edit.new_text }
      });
      if (!result?.ok) error = result?.content || copy.design.inspector.updateFailed;
    } catch {
      error = copy.design.inspector.updateFailed;
    }
  }

  function commitColor(decl: TokenDecl, event: Event) {
    void commit(decl, (event.currentTarget as HTMLInputElement).value);
  }

  /** A duration typed in ms; it is written back as a token value (`250ms`). */
  function commitDuration(decl: TokenDecl, event: Event) {
    const ms = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(ms) && ms >= 0) void commit(decl, formatDurationToken(ms));
  }

  function commitText(decl: TokenDecl, event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value.trim();
    if (value && value !== decl.value) void commit(decl, value);
  }

  const boxText = (box: DesignSelection['box']) => `${Math.round(box.x)}, ${Math.round(box.y)} · ${Math.round(box.width)} × ${Math.round(box.height)}`;
  const styleEntries = $derived(element ? Object.entries(element.styles) : []);
  const label = (name: string) => name.replace(/^--/, '');
</script>

<aside class="inspector" aria-label={copy.design.toolbar.inspector}>
  <header class="head">
    <h2 class="title">{copy.design.toolbar.inspector}</h2>
    <IconButton label={copy.design.toolbar.hideInspector} onclick={() => designStore.toggleInspector()}><X aria-hidden="true" /></IconButton>
  </header>

  <div class="tabs">
    <SegmentedControl label={copy.design.toolbar.inspector} options={tabOptions} value={tab} variant="tabs" shape="rect" onchange={(value) => (tab = value as Tab)} />
  </div>

  <div class="body">
    {#if tab === 'element'}
      {#if element}
        <section class="block">
          <p class="target">
            <code class="tag">&lt;{element.tag}&gt;</code>
            {#if showSelector}<span class="selector" title={element.selector}>{element.selector}</span>{/if}
          </p>
          {#if element.text}
            <p class="text">{element.text}</p>
          {/if}
          <dl class="facts">
            <dt>{copy.design.inspector.box}</dt>
            <dd>{boxText(element.box)}</dd>
          </dl>
          {#if designStore.selection.length > 1}
            <Button variant="link" size="xs" class="more" onclick={cycleElement}>
              {designStore.selection.length - 1} {copy.design.inspector.moreSelected}
            </Button>
          {/if}
        </section>

        <section class="block">
          <h3>{copy.design.inspector.styles}</h3>
          <dl class="styles">
            {#each styleEntries as [prop, value] (prop)}
              <dt>{prop}</dt>
              <dd>
                {#if isColorValue(value)}<span class="swatch" style:background={value} aria-hidden="true"></span>{/if}
                <span class="value" title={value}>{value}</span>
              </dd>
            {/each}
          </dl>
        </section>

        <section class="block">
          <h3>{copy.design.inspector.changes}</h3>
          <div class="quick">
            {#each quickChanges as change (change.id)}
              {@const Icon = change.icon}
              <Button variant="secondary" size="sm" class="quick-row" onclick={() => quick(change.prompt)}>
                <Icon aria-hidden="true" />{change.label}
              </Button>
            {/each}
          </div>
        </section>
      {:else}
        <div class="none">
          <p class="none-title">{copy.design.inspector.none}</p>
          <p class="none-hint">{copy.design.inspector.noneHint}</p>
        </div>
      {/if}
    {:else if tab === 'tokens'}
      {#if decls.length === 0}
        <div class="none">
          <p class="none-title">{copy.design.inspector.noTokens}</p>
          <p class="none-hint">{copy.design.inspector.tokensHint}</p>
        </div>
      {:else}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#each groups as group (group)}
          {@const items = lightTokens.filter((decl) => decl.group === group)}
          {#if items.length}
            <section class="block">
              <h3>{groupLabel[group]}</h3>
              <ul class="tokens">
                {#each items as decl (decl.name)}
                  {#if group === 'motion'}
                    {@render motionRow(decl)}
                  {:else}
                    {@render tokenRow(decl, colorToHex(decl.value))}
                  {/if}
                {/each}
              </ul>
            </section>
          {/if}
        {/each}

        {#if darkTokens.length}
          <section class="block">
            <h3>{copy.design.inspector.colors} · dark</h3>
            <ul class="tokens">
              {#each darkTokens.filter((decl) => decl.group === 'color') as decl (decl.name)}
                {@render tokenRow(decl, colorToHex(decl.value))}
              {/each}
            </ul>
          </section>
        {/if}
      {/if}
    {:else}
      <div class="code-head">
        {#if codeFiles.length > 1}
          <Select
            size="sm"
            aria-label={copy.design.inspector.file}
            options={codeFiles.map((name) => ({ value: name, label: name }))}
            value={activeCodeFile}
            onchange={(value) => (codeFile = value)}
          />
        {:else}
          <span class="file">{activeCodeFile || copy.design.inspector.noSource}</span>
        {/if}
        <Button variant="ghost" size="xs" onclick={copySource} disabled={!source}>
          {#if copied}<Check aria-hidden="true" />{:else}<Copy aria-hidden="true" />{/if}
          {copied ? copy.design.inspector.copied : copy.design.inspector.copy}
        </Button>
      </div>
      {#if source}
        <pre class="source"><code>{source}</code></pre>
      {:else}
        <div class="none"><p class="none-title">{copy.design.inspector.noSource}</p></div>
      {/if}
    {/if}
  </div>
</aside>

{#snippet motionRow(decl: TokenDecl)}
  {@const ms = durationMs(decl.value)}
  {@const curve = ms === null ? curvePath(decl.value) : null}
  <li class="token motion-row">
    <span class="name" title={decl.name}>{label(decl.name)}</span>
    {#if ms !== null}
      <span class="control">
        <Input variant="surface" type="number" min="0" max="10000" step="10" class="h-7 w-16 font-mono text-xs" value={Math.round(ms)} aria-label={decl.name} onchange={(event) => commitDuration(decl, event)} />
        <span class="unit">ms</span>
      </span>
    {:else}
      <span class="control">
        {#if curve}
          <svg class="curve" viewBox="0 0 40 40" role="img" aria-label={decl.value}><path d={curve} /></svg>
        {/if}
        <Select size="sm" aria-label={decl.name} options={easingChoices(decl)} value={decl.value.trim()} onchange={(value) => commit(decl, value)} />
      </span>
    {/if}
  </li>
{/snippet}

{#snippet tokenRow(decl: TokenDecl, hex: string | null)}
  <li class="token">
    <span class="name" title={decl.name}>{label(decl.name)}</span>
    <span class="control">
      {#if decl.group === 'color' || isColorValue(decl.value)}
        {#if hex}
          <UiColorInput  class={uiClass("picker", "ui-local-01966212")} value={hex} aria-label={decl.name} onchange={(event) => commitColor(decl, event)} />
        {:else}
          <span class="swatch" style:background={decl.value} aria-hidden="true"></span>
        {/if}
      {/if}
      <Input variant="surface" class="h-7 font-mono text-xs" value={decl.value} aria-label={decl.name} onchange={(event) => commitText(decl, event)} />
    </span>
  </li>
{/snippet}

<style>
  .inspector {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    background: var(--background);
    color: var(--foreground);
    font-size: var(--text-sm);
  }

  /* The header row matches the Code panes' bars: one line of title and close. */
  .head {
    display: flex;
    height: var(--chrome, 2.25rem);
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0 0.5rem 0 0.75rem;
  }

  .title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--foreground);
  }

  .tabs { flex-shrink: 0; padding: 0 0.75rem 0.5rem; }

  .body {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    gap: 1rem;
    padding: 0.25rem 0.75rem 0.75rem;
    overflow-y: auto;
  }

  .block { display: flex; flex-direction: column; gap: 0.4375rem; }

  h3 {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted-foreground);
  }

  /* One line: the tag, then the selector when it adds something, ellipsized and muted. */
  .target { display: flex; min-width: 0; align-items: baseline; gap: 0.5rem; margin: 0; }
  .tag { flex-shrink: 0; font-size: var(--text-code); color: var(--muted-foreground); }
  .selector { min-width: 0; overflow: hidden; color: var(--muted-foreground); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
  .text { margin: 0; overflow: hidden; display: -webkit-box; line-clamp: 3; -webkit-line-clamp: 3; -webkit-box-orient: vertical; color: var(--foreground); }
  /* A quiet link that flows with the text: no button padding, so its text lines up with the block. */
  :global(.inspector .more) { align-self: flex-start; height: auto; padding: 0; color: var(--muted-foreground); font-size: var(--text-xs); }

  .facts,
  .styles {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3125rem 0.75rem;
    margin: 0;
    align-items: center;
  }

  dt { color: var(--muted-foreground); font-size: var(--text-xs); }
  dd { display: flex; min-width: 0; align-items: center; gap: 0.375rem; margin: 0; }
  .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--text-xs); }

  .swatch {
    flex-shrink: 0;
    width: 0.875rem;
    height: 0.875rem;
    border-radius: 0.3125rem;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--foreground) 12%, transparent);
  }

  /* The quick changes are the app's buttons, one full-width row each, the way a menu lays out its rows. */
  .quick { display: flex; flex-direction: column; gap: 0.375rem; }
  :global(.inspector .quick-row) { width: 100%; justify-content: flex-start; padding-inline: 0.625rem; }
  :global(.inspector .quick-row svg) { color: var(--muted-foreground); }

  .none { display: flex; flex-direction: column; gap: 0.375rem; margin: 0; padding: 0.5rem 0; }
  .none-title { margin: 0; color: var(--foreground); }
  .none-hint { margin: 0; color: var(--muted-foreground); font-size: var(--text-xs); line-height: 1.5; }

  .error { margin: 0; color: var(--error); font-size: var(--text-xs); }

  .tokens { display: flex; flex-direction: column; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
  .token { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 9rem); align-items: center; gap: 0.5rem; }
  .name { overflow: hidden; color: var(--muted-foreground); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
  .control { display: flex; min-width: 0; align-items: center; gap: 0.375rem; }

  /* A motion token: a duration is a number field, an easing a curve beside its preset. */
  .motion-row { grid-template-columns: minmax(0, 1fr) auto; }
  .motion-row .control { justify-content: flex-end; }
  .unit { margin-left: -0.125rem; color: var(--muted-foreground); font-size: var(--text-xs); }
  .curve { flex-shrink: 0; width: 1.5rem; height: 1.5rem; overflow: visible; fill: none; stroke: var(--brand-accent); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

  :global(.picker.ui-local-01966212) {
    flex-shrink: 0;
    width: 1.375rem;
    height: 1.375rem;
    padding: 0;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    cursor: pointer;
  }

  :global(.picker.ui-local-01966212::-webkit-color-swatch-wrapper) { padding: 0; }
  :global(.picker.ui-local-01966212::-webkit-color-swatch) { border: 0; border-radius: 0.375rem; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--foreground) 12%, transparent); }

  .code-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; min-width: 0; }
  .file { min-width: 0; overflow: hidden; color: var(--muted-foreground); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }

  .source {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.625rem 0.75rem;
    overflow: auto;
    border-radius: 0.625rem;
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
    color: var(--foreground);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: 1.55;
    white-space: pre;
    tab-size: 2;
  }
</style>
