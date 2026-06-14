import type { AgentStep } from '$lib/types/chat';
import type { ToolDefinition } from '$lib/services/chat-api';

export function getToolDefinitions(): ToolDefinition[] {
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
        description: 'Read a file from the chat sandbox.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'write_file',
        description: 'Create or overwrite a chat sandbox file.',
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
        description: 'Delete a chat sandbox file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'list_files',
        description: 'List all files in the chat sandbox.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string', description: 'Glob filter (optional)' } }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'search_files',
        description: 'Search for text across chat sandbox files.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text or regex' },
            caseSensitive: { type: 'boolean' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'preview_project',
        description: 'Build an HTML preview from chat sandbox files. Call after writing HTML/CSS/JS files.',
        parameters: {
          type: 'object',
          properties: { entryPoint: { type: 'string', description: 'Entry HTML file (default: index.html)' } }
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_work_product',
        description: 'Create a professional evidence-aware work product from one shared report schema. Use this for multi-format deliverables such as report + DOCX + XLSX + PPTX + PDF.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Work product title' },
            subtitle: { type: 'string', description: 'Optional subtitle' },
            executiveSummary: { type: 'string', description: 'Short evidence-based summary' },
            sections: { type: 'array', description: 'Array of {title, content, bullets, citations}', items: { type: 'object' } },
            tables: { type: 'array', description: 'Optional data tables {name, columns, rows}', items: { type: 'object' } },
            sources: { type: 'array', description: 'Sources used {id,title,url,provider,snippet}', items: { type: 'object' } },
            limitations: { type: 'array', description: 'Known limits, blocked pages, thin evidence, or missing data', items: { type: 'string' } },
            formats: { type: 'array', description: 'Formats to create: md, html, docx, xlsx, pptx, pdf', items: { type: 'string' } },
            path: { type: 'string', description: 'Base output path without extension' }
          },
          required: ['title', 'sections', 'formats']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_report',
        description: 'Create a formatted report document (HTML or Markdown) as an artifact.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Report title' },
            sections: {
              type: 'array',
              description: 'Array of {title, content} objects',
              items: { type: 'object' }
            },
            format: { type: 'string', description: 'Output format: "html" or "markdown"' },
            path: { type: 'string', description: 'Output file path' },
            theme: { type: 'string', description: 'Color theme for HTML reports: "light" or "dark"' }
          },
          required: ['title', 'sections']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_document',
        description: 'Create a real DOCX document with a built-in preview. Use for reports, research writeups, briefs, essays, and formatted text documents.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Document title' },
            sections: { type: 'array', description: 'Array of {title or heading, content, bullets}', items: { type: 'object' } },
            content: { type: 'string', description: 'Fallback document body when sections are not provided' },
            path: { type: 'string', description: 'Output path ending in .docx' }
          },
          required: ['title']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_spreadsheet',
        description: 'Create a real XLSX workbook with a built-in table viewer. Use for tables, datasets, comparisons, budgets, analysis, and spreadsheet deliverables.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Workbook title' },
            sheets: { type: 'array', description: 'Array of {name, columns, rows}; rows can be objects or arrays', items: { type: 'object' } },
            columns: { type: 'array', description: 'Fallback columns for a single-sheet workbook', items: { type: 'string' } },
            rows: { type: 'array', description: 'Fallback rows for a single-sheet workbook', items: { type: 'object' } },
            path: { type: 'string', description: 'Output path ending in .xlsx' }
          },
          required: ['title']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_presentation',
        description: 'Create a real PPTX slide deck with a built-in slide viewer. Use when the user asks for slides, a deck, or a presentation.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Deck title' },
            slides: { type: 'array', description: 'Array of {title, content or bullets, notes}', items: { type: 'object' } },
            path: { type: 'string', description: 'Output path ending in .pptx' }
          },
          required: ['title', 'slides']
        }
      }
    },
    {
      type: 'function', function: {
        name: 'create_pdf',
        description: 'Create a PDF document with a built-in PDF viewer. Use when the user explicitly wants a PDF export.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'PDF title' },
            sections: { type: 'array', description: 'Array of {title or heading, content, bullets}', items: { type: 'object' } },
            content: { type: 'string', description: 'Fallback PDF body when sections are not provided' },
            path: { type: 'string', description: 'Output path ending in .pdf' }
          },
          required: ['title']
        }
      }
    },
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
  write_file: 'writing', delete_file: 'writing',
  preview_project: 'preview', create_report: 'writing',
  create_work_product: 'writing', create_document: 'writing', create_spreadsheet: 'writing', create_presentation: 'writing', create_pdf: 'writing',
  calculator: 'tool',
};
