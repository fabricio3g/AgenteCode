/**
 * The Design agent's file tools. They take a workspace root and plain
 * arguments, and nothing here can name a path outside that root: every
 * call lands in `workspace.ts`.
 */
import { DESIGN_FILE_TOOLS, DESIGN_LIMITS, type DesignFileTool, type DesignToolResult } from '../../shared/design.ts';
import { DesignPathError, editText, listFiles, readText, snapshot, writeText } from './workspace.ts';

const fail = (content: string): DesignToolResult => ({ ok: false, content });

export function isDesignFileTool(name: unknown): name is DesignFileTool {
  return typeof name === 'string' && (DESIGN_FILE_TOOLS as readonly string[]).includes(name);
}

/** Run one file tool. Unknown names are refused rather than guessed at. */
export function runDesignFileTool(root: string, name: unknown, args: Record<string, unknown> = {}): DesignToolResult {
  if (!isDesignFileTool(name)) return fail(`Unknown design tool: ${String(name)}`);
  try {
    switch (name) {
      case 'design_list': {
        const files = listFiles(root);
        if (!files.length) return { ok: true, content: 'The workspace is empty. Start with DESIGN.md, tokens.css and index.html.' };
        return { ok: true, content: files.map((file) => `${file.path} (${file.size} bytes)`).join('\n') };
      }
      case 'design_read': {
        const text = readText(root, args.path);
        const clipped = text.length > DESIGN_LIMITS.readChars;
        return { ok: true, content: clipped ? `${text.slice(0, DESIGN_LIMITS.readChars)}\n…(truncated, ${text.length} chars)` : text };
      }
      case 'design_write': {
        const written = writeText(root, args.path as string, args.content);
        return { ok: true, content: `Wrote ${written} (${Buffer.byteLength(args.content as string)} bytes).`, changed: [written] };
      }
      case 'design_edit': {
        const edit = editText(root, args.path as string, args.old_text, args.new_text, args.replace_all === true);
        return { ok: true, content: `Edited ${edit.path} (${edit.replaced} replacement${edit.replaced === 1 ? '' : 's'}).`, changed: [edit.path] };
      }
      case 'design_snapshot': {
        const version = snapshot(root, typeof args.label === 'string' ? args.label : '', false);
        return { ok: true, content: version ? `Saved version ${version.id}${version.label ? ` "${version.label}"` : ''}.` : 'Nothing changed since the last version.' };
      }
    }
  } catch (error) {
    if (error instanceof DesignPathError) return fail(error.message);
    const code = (error as NodeJS.ErrnoException)?.code;
    return fail(code === 'ENOENT' ? `No such file: ${String(args.path ?? '')}` : `Design tool failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
