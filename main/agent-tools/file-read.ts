import { AgentTool } from './base.ts';
import fs from 'node:fs';
import path from 'node:path';

export class FileReadTool extends AgentTool {
  name = 'file_read';
  description = 'Read a file from disk';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute file path' },
      encoding: { type: 'string', description: 'File encoding', default: 'utf-8' }
    },
    required: ['path']
  };

  async execute({ path: filePath, encoding }) {
    if (!fs.existsSync(filePath)) return { error: 'File not found' };
    const content = fs.readFileSync(filePath, encoding || 'utf-8');
    return { content: String(content) };
  }
}
