import type { ActionEvent } from './types';

export function hasUIContent(content: string | null | undefined): boolean {
  const text = String(content || '').trim();
  if (!text) return false;
  if (!/^root\s*=\s*[A-Z][A-Za-z0-9_]*\(/m.test(text)) return false;
  return /^[\s\S]*$/m.test(text);
}

export function buildUIActionMessage(event: ActionEvent): string {
  if (!event.formState || !Object.keys(event.formState).length) return event.humanFriendlyMessage;
  const stateLines = Object.entries(event.formState)
    .map(([key, value]) => {
      const raw = (value as any)?.value;
      if (raw == null || raw === '') return null;
      return `- ${key}: ${Array.isArray(raw) ? raw.join(', ') : String(raw)}`;
    })
    .filter(Boolean);
  if (!stateLines.length) return event.humanFriendlyMessage;
  return `${event.humanFriendlyMessage}\n\nForm values:\n${stateLines.join('\n')}`;
}
