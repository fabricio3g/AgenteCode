import { WebSearchTool } from './web-search.ts';
import { WebScrapeTool } from './web-scrape.ts';
import { RagQueryTool } from './rag-query.ts';
import { FileReadTool } from './file-read.ts';
import { FileWriteTool } from './file-write.ts';
import { CalculatorTool } from './calculator.ts';
import { CodeExecTool } from './code-exec.ts';

export const allTools = [
  new WebSearchTool(),
  new WebScrapeTool(),
  new RagQueryTool(),
  new FileReadTool(),
  new FileWriteTool(),
  new CalculatorTool(),
  new CodeExecTool(),
];
