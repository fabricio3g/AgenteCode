/**
 * Copy buttons for code blocks inside rendered markdown.
 *
 * Markdown is injected with `{@html …}`, so the button cannot be a component.
 * Previously two buttons ended up on every code block: the header button emitted
 * by the markdown renderer, which had *no handler at all* and did nothing when
 * clicked, and a second one appended imperatively into each `<pre>` after render
 * by the message body. This module keeps the header button and gives it the only
 * handler — one delegated listener for the whole document, installed once.
 */

import { writeToClipboard } from './clipboard';

export const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

export const CHECK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/** Markup for the header copy button. Emitted by the markdown code renderer. */
export const CODE_COPY_BUTTON_HTML =
  `<button class="code-copy-btn" type="button" aria-label="Copy code">${COPY_ICON_SVG}</button>`;

const FEEDBACK_MS = 1800;

let installed = false;

/**
 * Install the single delegated click handler. Safe to call more than once.
 * Returns a teardown function for tests.
 */
export function installCodeCopyDelegate(): () => void {
  if (installed || typeof document === 'undefined') return () => {};
  installed = true;

  const onClick = async (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('.code-copy-btn');
    if (!button) return;

    event.preventDefault();

    const wrapper = button.closest('.code-block-wrapper');
    const code = wrapper?.querySelector('pre code');
    const text = (code as HTMLElement | null)?.innerText ?? code?.textContent ?? '';
    if (!text) return;

    const ok = await writeToClipboard(text);
    if (!ok) return;

    button.innerHTML = CHECK_ICON_SVG;
    button.classList.add('copied');
    setTimeout(() => {
      button.innerHTML = COPY_ICON_SVG;
      button.classList.remove('copied');
    }, FEEDBACK_MS);
  };

  document.addEventListener('click', onClick);
  return () => {
    document.removeEventListener('click', onClick);
    installed = false;
  };
}
