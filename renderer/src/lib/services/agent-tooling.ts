import type { AgentStep } from '$lib/types/chat';
import type { ToolDefinition } from '$lib/services/chat-api';
import { getAllArtifacts, getEnabledArtifactIds } from '$lib/services/artifact-registry';

export function getToolDefinitions(executionMode?: 'workspace' | 'sandbox', artifactToggles: Record<string, boolean> = {}): ToolDefinition[] {
  const isWorkspace = executionMode === 'workspace';
  const fileScope = isWorkspace ? 'workspace' : 'chat sandbox';
  const enabledArtifacts = getEnabledArtifactIds(artifactToggles);
  return [
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
        description: 'Fetch and read content from a URL.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'URL to fetch' } },
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
            topK: { type: 'number', description: 'Max results (default 5)' }
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
  ];
}

export const STEP_TYPE: Record<string, AgentStep['type']> = {
  web_search: 'searching', fetch_url: 'reading',
  query_knowledge: 'reading',
  read_file: 'reading', list_files: 'reading', search_files: 'reading',
  write_file: 'writing', delete_file: 'writing', edit_file: 'writing',
  bash: 'executing',
  preview_project: 'preview', create_report: 'writing',
  create_work_product: 'writing', create_document: 'writing', create_spreadsheet: 'writing', create_presentation: 'writing', create_pdf: 'writing', create_chart: 'writing', create_diagram: 'writing', create_map: 'writing', create_dashboard: 'writing',
  calculator: 'tool',
};
