/**
 * The Home agent's tools, grouped for the composer's Tools menu.
 *
 * One registry: the menu lists these groups, and `getToolDefinitions` drops
 * whatever the user switched off (`ui.home_tools_disabled`, which holds group
 * ids and/or individual tool names). A tool in no group (a future or custom
 * one) is always offered.
 */

import type { ToolDefinition } from '$lib/services/chat-api';

export type HomeToolGroupId = 'web' | 'browser' | 'files' | 'productivity' | 'media' | 'data' | 'code';

export interface HomeToolGroup {
  id: HomeToolGroupId;
  /** English fallback; the UI translates through `home.tools.group.<id>`. */
  label: string;
  tools: readonly string[];
}

export const HOME_TOOL_GROUPS: readonly HomeToolGroup[] = [
  { id: 'web', label: 'Web', tools: ['web_search', 'fetch_url'] },
  {
    id: 'browser',
    label: 'Browser',
    tools: [
      'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill', 'browser_type', 'browser_press',
      'browser_scroll', 'browser_wait', 'browser_back', 'browser_forward', 'browser_reload', 'browser_hover', 'browser_select',
      'browser_read', 'browser_tabs', 'browser_console', 'browser_screenshot'
    ]
  },
  {
    id: 'files',
    label: 'Files & documents',
    tools: [
      'read_file', 'write_file', 'edit_file', 'delete_file', 'list_files', 'search_files', 'query_knowledge',
      'read_document', 'extract_tables',
      'create_report', 'create_work_product', 'create_document', 'create_spreadsheet', 'create_presentation', 'create_pdf'
    ]
  },
  { id: 'productivity', label: 'Productivity', tools: ['notes', 'todos', 'reminders', 'convert_units', 'convert_time'] },
  { id: 'media', label: 'Media', tools: ['ocr_image', 'describe_image', 'transcribe_audio'] },
  {
    id: 'data',
    label: 'Data & charts',
    tools: [
      'calculator', 'get_weather', 'convert_currency', 'get_quote',
      'create_chart', 'create_dashboard', 'create_info_card', 'create_html_card', 'create_widget', 'create_diagram', 'create_map'
    ]
  },
  { id: 'code', label: 'Code', tools: ['bash', 'get_diagnostics', 'preview_project'] }
];

const GROUP_OF = new Map<string, HomeToolGroupId>(HOME_TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => [tool, group.id] as const)));

export function toolGroupOf(toolName: string): HomeToolGroupId | undefined {
  return GROUP_OF.get(toolName);
}

/** Whether a tool is switched off, directly or through its group. */
export function isToolDisabled(toolName: string, disabled: readonly string[] | undefined): boolean {
  if (!disabled?.length) return false;
  if (disabled.includes(toolName)) return true;
  const group = GROUP_OF.get(toolName);
  return !!group && disabled.includes(group);
}

export function filterEnabledTools(tools: ToolDefinition[], disabled: readonly string[] | undefined): ToolDefinition[] {
  return disabled?.length ? tools.filter((tool) => !isToolDisabled(tool.function.name, disabled)) : tools;
}

/** Flip a whole group in a disabled list (per-tool entries of that group are cleared). */
export function toggleGroup(disabled: readonly string[], group: HomeToolGroupId, enabled: boolean): string[] {
  const members = new Set(HOME_TOOL_GROUPS.find((entry) => entry.id === group)?.tools ?? []);
  const rest = disabled.filter((entry) => entry !== group && !members.has(entry));
  return enabled ? rest : [...rest, group];
}

export function toggleTool(disabled: readonly string[], tool: string, enabled: boolean): string[] {
  const rest = disabled.filter((entry) => entry !== tool);
  return enabled ? rest : [...rest, tool];
}
