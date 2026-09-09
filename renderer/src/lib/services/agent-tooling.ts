import type { AgentStep } from '$lib/types/chat';
import type { ToolDefinition } from '$lib/services/chat-api';
import { getAllArtifacts, getEnabledArtifactIds } from '$lib/services/artifact-registry';

/** Pi-inspired coding tools (Flaxeo Agent code profile) + web + diagnostics. */
export const CODE_AGENT_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'list_files',
  'search_files',
  'bash',
  'web_search',
  'fetch_url',
  'query_knowledge',
  'get_diagnostics'
]);

/** Simple Chat Agent: research + calc + sandbox files (no host bash). */
export const CHAT_AGENT_TOOL_NAMES = new Set([
  'web_search',
  'fetch_url',
  'query_knowledge',
  'calculator',
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
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
  'get_weather',
  'convert_currency',
  'get_quote',
  'export_research_package'
]);

export type AgentProfile = 'chat' | 'code' | 'search' | 'work';

export function getToolDefinitions(
  executionMode?: 'workspace' | 'sandbox',
  artifactToggles: Record<string, boolean> = {},
  agentProfile: AgentProfile = 'work'
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
          'Fetch and extract readable text from a public http(s) URL. Uses Mozilla Readability for HTML (token-efficient article text). Also extracts text from remote PDF and DOCX. Private/localhost URLs are blocked.',
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
        description: 'Search indexed documents attached to the conversation.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            topK: { type: 'number', description: 'Max results (default 16, max 40) — full chunks, no short token budget' }
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
    {
      type: 'function', function: {
        name: 'browser_open',
        description:
          'Open a URL in the floating agent browser panel (isolated profile, user watches live). Use for any task needing a real page. Returns a text snapshot of the page.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'http(s) URL to open' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_navigate',
        description: 'Navigate the active agent browser tab to an http(s) URL. Returns a text snapshot.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'http(s) URL to load' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_snapshot',
        description: 'Read the active agent browser tab: URL, title, text, links, inputs, buttons.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_click',
        description: 'Click a control in the active agent browser tab by its visible text. Returns a fresh snapshot.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Visible text of the link or button to click' }
          },
          required: ['text']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_type',
        description: 'Focus a field by CSS selector in the active agent browser tab and type text into it.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of the input field' },
            text: { type: 'string', description: 'Text to type' }
          },
          required: ['selector', 'text']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'browser_screenshot',
        description: 'Capture a screenshot of the active agent browser tab. Returns a data URL image.',
        parameters: { type: 'object', properties: {} }
      }
    },
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

  if (agentProfile === 'code') {
    return tools.filter((tool) => CODE_AGENT_TOOL_NAMES.has(tool.function.name));
  }
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
  browser_click: 'executing', browser_type: 'executing', browser_screenshot: 'reading',
  query_knowledge: 'reading',
  read_file: 'reading', list_files: 'reading', search_files: 'reading',
  write_file: 'writing', delete_file: 'writing', edit_file: 'writing',
  bash: 'executing',
  get_diagnostics: 'reading',
  preview_project: 'preview', create_report: 'writing',
  create_work_product: 'writing', create_document: 'writing', create_spreadsheet: 'writing', create_presentation: 'writing', create_pdf: 'writing', create_chart: 'writing', create_diagram: 'writing', create_map: 'writing', create_dashboard: 'writing',
  create_info_card: 'writing', create_html_card: 'writing',
  get_weather: 'searching', convert_currency: 'tool', get_quote: 'searching',
  export_research_package: 'writing',
  calculator: 'tool',
};
