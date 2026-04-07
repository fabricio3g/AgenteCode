import { WebSearchTool } from './web-search.js';
import { WebScrapeTool } from './web-scrape.js';
import { RagQueryTool } from './rag-query.js';
import { FileReadTool } from './file-read.js';
import { FileWriteTool } from './file-write.js';
import { CalculatorTool } from './calculator.js';
import { CodeExecTool } from './code-exec.js';

export const allTools = [
  new WebSearchTool(),
  new WebScrapeTool(),
  new RagQueryTool(),
  new FileReadTool(),
  new FileWriteTool(),
  new CalculatorTool(),
  new CodeExecTool(),
];
