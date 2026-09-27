import type { ChatSession } from '$lib/types/chat';

/**
 * Shared session export.
 *
 * Single source of truth for chat/code markdown export.
 * Replaces duplicated builders in AppShell and Sidebar.
 */
export function buildSessionMarkdown(chat: Pick<ChatSession, 'title' | 'messages'>, dateStr: string): string {
  const lines: string[] = [`# ${chat.title || 'Chat'}\n\n*Exported ${dateStr}*\n`];
  for (const m of chat.messages) {
    lines.push('---');
    if (m.role === 'user') {
      lines.push(`**You:**\n\n${m.content}`);
    } else {
      lines.push(`**Assistant**${m.model ? ` (${m.model})` : ''}:\n\n${m.content}`);
    }
  }
  return lines.join('\n\n');
}

export function sessionExportFilename(title: string, dateStr: string): string {
  return `${(title || 'chat').replace(/[^a-z0-9]+/gi, '_')}_${dateStr}.md`;
}

export function downloadSessionMarkdown(chat: Pick<ChatSession, 'title' | 'messages'>): void {
  const dateStr = new Date().toISOString().slice(0, 10);
  const blob = new Blob([buildSessionMarkdown(chat, dateStr)], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.setAttribute('download', sessionExportFilename(chat.title, dateStr));
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
