// A Code conversation as Markdown (the TUI's /export): what was asked,
// what the agent said, and the tools it used.

import type { ChatMessage } from '$lib/types/chat';

export function chatToMarkdown(title: string, messages: ChatMessage[]): string {
  const out = [`# ${title}`, ''];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push('## You', '', message.content.trim(), '');
      continue;
    }
    if (message.role !== 'assistant') continue;
    out.push('## Agente', '');
    const tools = (message.agentSteps ?? []).filter((step) => step.toolName && !step.preface);
    if (tools.length) {
      out.push(...tools.map((step) => `- \`${step.toolName}\` ${step.label}`.trimEnd()), '');
    }
    if (message.content.trim()) out.push(message.content.trim(), '');
  }
  return `${out.join('\n').trim()}\n`;
}

/** A file name from a title: letters, digits and dashes. */
export function exportFileName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `${slug || 'conversation'}.md`;
}
