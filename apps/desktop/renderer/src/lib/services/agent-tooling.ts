import type { AgentStep } from '$lib/types/chat';
import type { ToolDefinition } from '$lib/services/chat/types';
import { HOME_EXTRA_TOOL_DEFS } from '$lib/services/agent-tool-home-schemas';
import { DOMAIN_TOOL_DEFS } from '$shared/domains';
import { filterEnabledTools } from '$lib/services/agent-tool-registry';
import { getAllArtifacts, getEnabledArtifactIds } from '$lib/services/artifact-registry';

/** Simple Chat Agent: research + calc + sandbox files (no host bash). */
export const CHAT_AGENT_TOOL_NAMES = new Set([
  'web_search',
  'fetch_url',
  'query_knowledge',
  'calculator',
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_scroll',
  'browser_wait',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_hover',
  'browser_select',
  'browser_read',
  'browser_tabs',
  'browser_console',
  'browser_screenshot',
  'read_file',
  'write_file',
  'list_files',
  'search_files',
  'preview_project',
  'create_report',
  'create_work_product',
  'create_document',
  'create_spreadsheet',
  'create_presentation',
  'create_pdf',
  'create_chart',
  'create_diagram',
  'create_map',
  'create_dashboard',
  'create_info_card',
  'create_html_card',
  'create_widget',
  'create_lesson',
  'create_scene_3d',
  'get_weather',
  'convert_currency',
  'get_quote',
  'read_document',
  'extract_tables',
  'notes',
  'todos',
  'reminders',
  'convert_units',
  'convert_time',
  'ocr_image',
  'describe_image',
  'transcribe_audio',
  ...DOMAIN_TOOL_DEFS.map(def => def.name)
]);

export type AgentProfile = 'chat' | 'code' | 'search' | 'work';

export function getToolDefinitions(
  executionMode?: 'workspace' | 'sandbox',
  artifactToggles: Record<string, boolean> = {},
  agentProfile: AgentProfile = 'work',
  disabledTools: readonly string[] = []
): ToolDefinition[] {
  const tools = buildToolDefinitions(executionMode, artifactToggles, agentProfile);
  tools.push(...DOMAIN_TOOL_DEFS.map(def => ({ type: 'function' as const, function: def })));
  return filterEnabledTools(tools, disabledTools);
}

function buildToolDefinitions(
  executionMode: 'workspace' | 'sandbox' | undefined,
  artifactToggles: Record<string, boolean>,
  agentProfile: AgentProfile
): ToolDefinition[] {
  const isWorkspace = executionMode === 'workspace';
  const fileScope = isWorkspace ? 'workspace' : 'chat sandbox';
  const enabledArtifacts = getEnabledArtifactIds(artifactToggles);
  const tools: ToolDefinition[] = [
    {
      type: 'function', function: {
        name: 'web_search',
        description: 'Search the web for up-to-date information. The tool automatically receives recent conversation context, so write a focused query and include key entities when helpful.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            mode: { type: 'string', description: 'Depth mode: "search" (fast), "deep" (thorough), or "max" (exhaustive)' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'fetch_url',
        description:
          'Read a public http(s) URL as clean markdown: Mozilla Readability (Firefox Reader View) finds the article and keeps headings, lists, tables, code and links, without menus, ads or scripts. Returns the whole page. Also extracts text from remote PDF and DOCX. Private/localhost URLs are blocked.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Public http(s) URL of a page, PDF, or Word (.docx) document'
            }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'read_file',
        description: isWorkspace ? `Read a file from the ${fileScope}. The path is relative to the workspace root. Use offset and limit for large files.` : `Read a file from the ${fileScope}.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            offset: { type: 'number', description: 'Line number to start reading from (1-indexed, optional)' },
            limit: { type: 'number', description: 'Maximum number of lines to read (optional)' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'write_file',
        description: isWorkspace ? `Create or overwrite a file in the ${fileScope}. Parent directories are created automatically. The file persists to disk.` : `Create or overwrite a ${fileScope} file.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'File content' },
            mode: { type: 'string', description: 'Write mode: "overwrite" (default), "append", or "create" (fails if exists)' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'delete_file',
        description: `Delete a file from the ${fileScope}.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'edit_file',
        description: isWorkspace
          ? `Make precise text replacements in a file on disk. Use for targeted changes instead of rewriting the whole file. Each edit replaces exact oldText with newText. Edits are applied against the original file content, not incrementally.`
          : 'Edit a file with text replacements. Available only in workspace mode.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace root' },
            edits: {
              type: 'array',
              description: 'Array of {oldText, newText} replacements. oldText must match exactly in the file.'
            }
          },
          required: ['path', 'edits']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'list_files',
        description: isWorkspace ? `List files in the ${fileScope}. Use pattern to filter by glob.` : `List all files in the ${fileScope}.`,
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string', description: 'Glob filter (optional)' } }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'search_files',
        description: isWorkspace ? `Search for text across ${fileScope} files. Reads files from disk.` : `Search for text across ${fileScope} files.`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text or regex' },
            caseSensitive: { type: 'boolean' },
            path: { type: 'string', description: 'Subdirectory to search (optional, relative to workspace root)' },
            maxResults: { type: 'number', description: 'Max results (default 50)' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'bash',
        description: isWorkspace
          ? `Run any shell command through the native system shell. Works for all commands (dir, git, npm, python, etc.). Output is streamed back. Use for running tests, installing dependencies, git operations, building, and other CLI tasks. Commands have a 30-second timeout.`
          : 'Run a shell command. Available only in workspace mode.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 30000)' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'preview_project',
        description: 'Build a self-contained HTML preview from sandbox files. External scripts, styles, and assets are blocked for deterministic rendering.',
        parameters: {
          type: 'object',
          properties: { entryPoint: { type: 'string', description: 'Entry HTML file (default: index.html)' } }
        }
      }
    },
    ...getAllArtifacts().filter(a => enabledArtifacts.has(a.id)).map(a => a.toolDefinition),
    {
      type: 'function', function: {
        name: 'query_knowledge',
        description: 'Search indexed documents. The default scope is the conversation\'s own files plus anything pinned to the project; scope "library" searches every file indexed on this machine. Each passage in `context` is numbered `[n]` with its source, section/page and line range; cite claims as [n].',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            topK: { type: 'number', description: 'Max results (default 16, max 40) — full chunks, no short token budget' },
            scope: { type: 'string', enum: ['chat', 'library'], description: 'chat (default) = this conversation\'s files and pinned files; library = every indexed file' },
            file_type: { type: 'string', description: 'Only documents of this type, e.g. pdf, xlsx, markdown' },
            files: { type: 'array', items: { type: 'string' }, description: 'Only these files, by name or hash' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'calculator',
        description: 'Evaluate a mathematical expression safely.',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Math expression to evaluate (e.g., "123 * 456 + 789", "Math.sqrt(144) + Math.pow(2, 10)")' }
          },
          required: ['expression']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'get_weather',
        description:
          'Get current weather for a place via Open-Meteo (open-source, no API key). Inserts an in-chat info card. Use for weather/conditions questions. Never invent temperatures.',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City or place name (e.g. Madrid, Paris, New York)' }
          },
          required: ['location']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'convert_currency',
        description:
          'Convert money between currencies via Frankfurter/ECB rates (open-source, no API key). Inserts an in-chat info card. Use for FX conversion. Never invent rates.',
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Amount to convert' },
            from: { type: 'string', description: 'Source ISO currency code (e.g. USD)' },
            to: { type: 'string', description: 'Target ISO currency code (e.g. EUR)' }
          },
          required: ['amount', 'from', 'to']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'get_quote',
        description:
          'Get a stock or crypto quote (Stooq for equities, CoinGecko for major crypto). Inserts an in-chat info card. Never invent prices.',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, MSFT, BTC, ETH)' }
          },
          required: ['symbol']
        }
      }
    },
    // Agent browser (shared driver in the main process): snapshots list
    // elements with refs, and every action takes those refs.
    {
      type: 'function', function: {
        name: 'browser_open',
        description:
          'Open a URL in the agent browser panel (isolated profile, the user watches live) and return a snapshot: title, URL, visible elements with refs (e12), and text.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'http(s) URL to open' },
            newTab: { type: 'boolean', description: 'Open in a new tab' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_snapshot',
        description: 'Read the current page: URL, title, visible elements with refs, new console errors, and the visible text.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_click',
        description: 'Click an element by its ref from the latest snapshot. Returns the new snapshot.',
        parameters: {
          type: 'object',
          properties: { ref: { type: 'string', description: 'Element ref, e.g. "e12"' } },
          required: ['ref']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_fill',
        description: 'Replace the text in a field by ref; set submit to press Enter afterwards (search boxes, forms).',
        parameters: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Element ref, e.g. "e4"' },
            text: { type: 'string', description: 'Text to enter' },
            submit: { type: 'boolean', description: 'Press Enter after typing' }
          },
          required: ['ref', 'text']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_press',
        description: 'Press a key: Enter, Tab, Escape, Backspace, Space, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End.',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_scroll',
        description: 'Scroll by pages (default one page down), or bring an element into view by ref.',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['up', 'down'] },
            pages: { type: 'number' },
            ref: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_wait',
        description: 'Wait until text or a CSS selector appears, or the URL contains a string (default 8s, max 30s).',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            selector: { type: 'string' },
            url: { type: 'string' },
            timeoutMs: { type: 'number' }
          }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_back',
        description: 'Go back in the browser history.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_forward',
        description: 'Go forward in the browser history. Returns the new snapshot.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_reload',
        description: 'Reload the current page. Returns the new snapshot.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_hover',
        description: 'Move the pointer over an element by ref (menus, tooltips). Returns the new snapshot.',
        parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref, e.g. "e12"' } }, required: ['ref'] }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_select',
        description: 'Choose an option in a <select> by ref, using its value or visible label.',
        parameters: {
          type: 'object',
          properties: { ref: { type: 'string', description: 'Select ref, e.g. "e7"' }, value: { type: 'string', description: 'Option value or label' } },
          required: ['ref', 'value']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_read',
        description: "Read the page's main text, or one element's text/value by ref. Long text is truncated; use it when the snapshot text is not enough.",
        parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Optional element ref' } } }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_tabs',
        description: 'List the browser tabs, or switch to / close one by tab_id (ids from the list).',
        parameters: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['list', 'switch', 'close'] }, tab_id: { type: 'string' } },
          required: ['action']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_console',
        description: "Read the page's console output, uncaught exceptions and failed requests since the last check.",
        parameters: { type: 'object', properties: { level: { type: 'string', enum: ['error', 'warning', 'all'] } } }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_screenshot',
        description: 'Capture the visible page as an image (for layout and visual questions; vision models only).',
        parameters: { type: 'object', properties: {} }
      }
    },
    ...HOME_EXTRA_TOOL_DEFS,
    {
      type: 'function', function: {
        name: 'get_diagnostics',
        description:
          'LSP-like project diagnostics without a full language server: runs TypeScript (tsc), optional ESLint on a path, and Ruff for Python when available. Use after edits to find type/lint errors.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional file or directory relative to workspace root to focus checks' },
            language: {
              type: 'string',
              description: 'Optional: "typescript" | "javascript" | "python" to force a toolchain'
            }
          }
        }
      }
    },
  ];

  if (agentProfile === 'chat') {
    // Chat agent: no host bash/edit_file/delete_file/diagnostics
    return tools.filter((tool) => CHAT_AGENT_TOOL_NAMES.has(tool.function.name));
  }
  // work / default: full tool surface (bash still gated to workspace mode)
  return tools;
}

export const STEP_TYPE: Record<string, AgentStep['type']> = {
  web_search: 'searching', fetch_url: 'reading',
  browser_open: 'reading', browser_navigate: 'reading', browser_snapshot: 'reading',
  browser_click: 'executing', browser_type: 'executing', browser_fill: 'executing', browser_press: 'executing',
  browser_scroll: 'reading', browser_wait: 'reading', browser_back: 'reading', browser_forward: 'reading', browser_reload: 'reading', browser_hover: 'executing', browser_select: 'executing', browser_read: 'reading', browser_tabs: 'reading', browser_console: 'reading',
  browser_screenshot: 'reading',
  query_knowledge: 'reading',
  read_file: 'reading', list_files: 'reading', search_files: 'reading',
  write_file: 'writing', delete_file: 'writing', edit_file: 'writing',
  bash: 'executing',
  get_diagnostics: 'reading',
  preview_project: 'preview', create_report: 'writing',
  create_work_product: 'writing', create_document: 'writing', create_spreadsheet: 'writing', create_presentation: 'writing', create_pdf: 'writing', create_chart: 'writing', create_diagram: 'writing', create_map: 'writing', create_dashboard: 'writing',
  create_info_card: 'writing', create_html_card: 'writing', create_widget: 'writing', create_lesson: 'writing', create_scene_3d: 'writing',
  get_weather: 'searching', convert_currency: 'tool', get_quote: 'searching',
  calculator: 'tool',
  read_document: 'reading', extract_tables: 'reading', notes: 'tool', todos: 'tool', reminders: 'tool',
  convert_units: 'tool', convert_time: 'tool', ocr_image: 'reading', describe_image: 'reading', transcribe_audio: 'reading',
};
