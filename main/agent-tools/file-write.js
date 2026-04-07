import { AgentTool } from './base.js';
import fs from 'node:fs';
import path from 'node:path';

export class FileWriteTool extends AgentTool {
  name = 'file_write';
  description = 'Write content to a file';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute file path' },
      content: { type: 'string', description: 'Content to write' },
      create_dirs: { type: 'boolean', description: 'Create parent directories' }
    },
    required: ['path', 'content']
  };

  async execute({ path: filePath, content, create_dirs }) {
    if (create_dirs) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, path: filePath };
  }
}
