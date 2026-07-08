import type { ToolDefinition } from '$lib/services/chat-api';

export interface ArtifactTypeEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  toolDefinition: ToolDefinition;
  defaultEnabled: boolean;
}

const builtinArtifacts: ArtifactTypeEntry[] = [
  {
    id: 'report',
    name: 'Reports',
    description: 'HTML or Markdown formatted report documents',
    icon: 'file-text',
    defaultEnabled: true,
    toolDefinition: {
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
    }
  },
  {
    id: 'work_product',
    name: 'Work Products',
    description: 'Multi-format professional deliverables (report, DOCX, XLSX, PPTX, PDF)',
    icon: 'briefcase',
    defaultEnabled: true,
    toolDefinition: {
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
    }
  },
  {
    id: 'document',
    name: 'Documents',
    description: 'DOCX word processing documents with preview',
    icon: 'file-text',
    defaultEnabled: true,
    toolDefinition: {
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
    }
  },
  {
    id: 'spreadsheet',
    name: 'Spreadsheets',
    description: 'XLSX workbook spreadsheets with table viewer',
    icon: 'table',
    defaultEnabled: true,
    toolDefinition: {
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
    }
  },
  {
    id: 'presentation',
    name: 'Presentations',
    description: 'PPTX slide decks with slide viewer',
    icon: 'presentation',
    defaultEnabled: true,
    toolDefinition: {
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
    }
  },
  {
    id: 'pdf',
    name: 'PDF Files',
    description: 'PDF documents with built-in viewer',
    icon: 'file',
    defaultEnabled: true,
    toolDefinition: {
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
    }
  },
  {
    id: 'chart',
    name: 'Charts',
    description: 'D3.js data visualizations (bar, line, pie, donut)',
    icon: 'bar-chart',
    defaultEnabled: true,
    toolDefinition: {
      type: 'function', function: {
        name: 'create_chart',
        description: 'Create a D3.js chart visualization as an HTML artifact. Supports bar, line, pie, and donut chart types. The chart is rendered as a standalone HTML page that can be previewed in the sandbox.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Chart title' },
            chart_type: { type: 'string', description: 'Chart type: "bar", "line", "pie", or "donut"' },
            labels: { type: 'array', description: 'Array of label strings for the x-axis or pie slices', items: { type: 'string' } },
            datasets: {
              type: 'array',
              description: 'Array of {label, data} objects. Data is an array of numbers matching labels length.',
              items: { type: 'object' }
            },
            path: { type: 'string', description: 'Output path (defaults to chart.html)' },
          },
          required: ['title', 'labels', 'datasets']
        }
      }
    }
  },
  {
    id: 'diagram',
    name: 'Diagrams',
    description: 'Mermaid.js diagrams (flowcharts, sequence, ER, Gantt, mindmaps, and more)',
    icon: 'workflow',
    defaultEnabled: true,
    toolDefinition: {
      type: 'function', function: {
        name: 'create_diagram',
        description: 'Create a diagram using Mermaid.js syntax. Supports flowcharts, sequence diagrams, class diagrams, ER diagrams, Gantt charts, mindmaps, timelines, and more. The diagram is rendered as an interactive HTML artifact viewable in the sandbox.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Diagram title' },
            diagram_type: { type: 'string', description: 'Mermaid diagram type: "flowchart", "sequence", "class", "er", "gantt", "mindmap", "timeline", "state", "pie", "quadrant", "sankey", "kanban", or "gitgraph"' },
            mermaid_source: { type: 'string', description: 'Mermaid syntax source code defining the diagram' },
            path: { type: 'string', description: 'Output path (defaults to diagram.html)' },
          },
          required: ['title', 'mermaid_source']
        }
      }
    }
  },
  {
    id: 'map',
    name: 'Maps',
    description: 'Leaflet.js interactive maps with markers, polylines, and GeoJSON overlays',
    icon: 'map',
    defaultEnabled: true,
    toolDefinition: {
      type: 'function', function: {
        name: 'create_map',
        description: 'Create an interactive map visualization using Leaflet.js with OpenStreetMap tiles. Supports markers, popups, polylines, circles, and GeoJSON overlays. Rendered as an HTML artifact viewable in the sandbox.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Map title' },
            latitude: { type: 'number', description: 'Center latitude (default 51.505)' },
            longitude: { type: 'number', description: 'Center longitude (default -0.09)' },
            zoom: { type: 'number', description: 'Initial zoom level (default 13)' },
            markers: {
              type: 'array',
              description: 'Map markers with coordinates and optional popup text',
              items: { type: 'object' }
            },
            polylines: {
              type: 'array',
              description: 'Polylines as arrays of {lat, lng} coordinate objects',
              items: { type: 'object' }
            },
            path: { type: 'string', description: 'Output path (defaults to map.html)' },
          },
          required: ['title']
        }
      }
    }
  },
  {
    id: 'dashboard',
    name: 'Dashboards',
    description: 'Live metric cards, KPIs, and summary stat panels',
    icon: 'layout-dashboard',
    defaultEnabled: true,
    toolDefinition: {
      type: 'function', function: {
        name: 'create_dashboard',
        description: 'Create a dashboard HTML artifact with metric cards, KPI summaries, and stat panels. Displays key numbers with labels, trends, and optional charts. Rendered as an interactive HTML artifact viewable in the sandbox.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Dashboard title' },
            subtitle: { type: 'string', description: 'Optional subtitle or description' },
            metrics: {
              type: 'array',
              description: 'Metric cards [{label, value, trend, unit, icon}]',
              items: { type: 'object' }
            },
            sections: {
              type: 'array',
              description: 'Text/markdown sections with optional sub-headings',
              items: { type: 'object' }
            },
            path: { type: 'string', description: 'Output path (defaults to dashboard.html)' },
          },
          required: ['title', 'metrics']
        }
      }
    }
  },
];

export function getAllArtifacts(): ArtifactTypeEntry[] {
  return builtinArtifacts;
}

export function getEnabledArtifactIds(toggles: Record<string, boolean> = {}): Set<string> {
  const enabled = new Set<string>();
  for (const artifact of builtinArtifacts) {
    const toggle = toggles[artifact.id];
    if (toggle === undefined ? artifact.defaultEnabled : toggle) {
      enabled.add(artifact.id);
    }
  }
  return enabled;
}

const toolNameToId: Record<string, string> = Object.fromEntries(
  builtinArtifacts.map((a) => [a.toolDefinition.function.name, a.id])
);

export function getArtifactIdByToolName(toolName: string): string | undefined {
  return toolNameToId[toolName];
}

export function isArtifactToolEnabled(toolName: string, toggles: Record<string, boolean>): boolean {
  const id = getArtifactIdByToolName(toolName);
  if (!id) return true;
  const artifact = builtinArtifacts.find((a) => a.id === id);
  if (!artifact) return true;
  return toggles[id] ?? artifact.defaultEnabled;
}
