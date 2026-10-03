import { invoke, isElectron } from '$lib/services/bridge';

/**
 * One clipboard write, with the legacy fallback for the cases where the async
 * Clipboard API is unavailable or rejects (no focus, insecure context).
 */
export async function writeToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (isElectron()) {
    try { const result = await invoke<{ ok: boolean }>('clipboard_write', { text }); if (result?.ok) return true; } catch { /* Use browser fallbacks below. */ }
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the textarea path.
  }

  const area = document.createElement('textarea');
  const focused = document.activeElement;
  try {
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}
