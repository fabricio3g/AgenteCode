/**
 * The Design agent's tools as shared agent-core tools. File tools forward to
 * main (`design_tool`), which owns the path jail; preview and inspect build
 * the same inlined document the canvas shows and have main render it in the
 * offline guest. Nothing here touches a path itself.
 */
import type { AgentTool, ToolResult } from '$shared/agent-core/types';
import {
  DESIGN_BORROWED_TOOLS, DESIGN_ENTRY, DESIGN_RESEARCH_TOOL_SPECS, DESIGN_TOOL_SPECS,
  type DesignFiles, type DesignImageResult, type DesignReferenceResult, type DesignRenderRequest, type DesignRenderResult, type DesignToolResult
} from '$shared/design';
import { invoke } from '$lib/services/bridge';
import { buildPreviewHtml } from '$lib/utils/preview-builder';
import { composeFilmstrip } from './design-filmstrip';
import { DESIGN_3D_TOOL, type BlenderState } from '$shared/design-3d';

/** What the tools need from the run around them: a step row, a budget tick, and whether the model can see. */
export interface DesignToolHost {
  chatId: string;
  /** Opens a live step in the transcript; the returned function closes it. */
  step(tool: string, detail: string): (ok: boolean, detail?: string) => void;
  /** Counts one tool call against the turn budget. */
  count(): void;
  /** Whether the active model accepts images (a preview then returns pixels). */
  vision(): Promise<boolean>;
}

const text = (content: string, isError = false): ToolResult => ({ content, ...(isError ? { isError } : {}) });
const asString = (value: unknown) => (typeof value === 'string' ? value : '');

/** The page a tool asked for, normalised to a workspace path. */
export function pageFrom(value: unknown): string {
  const raw = asString(value).trim().replace(/^\.?\//, '');
  return raw || DESIGN_ENTRY;
}

/** The sentence the model reads after a render: size, console errors and blocked network references. */
export function renderSummary(page: string, result: DesignRenderResult, externalRefs: string[]): string {
  const lines = [`Rendered ${page} at ${result.width}x${result.height}.`];
  lines.push(result.consoleErrors.length ? `Console errors:\n- ${result.consoleErrors.join('\n- ')}` : 'No console errors.');
  if (externalRefs.length) lines.push(`Blocked external resources (the preview is offline; use local files or inline SVG): ${externalRefs.slice(0, 6).join(', ')}`);
  return lines.join('\n');
}

/** Build the canvas's document for a page and have main render it. */
async function render(chatId: string, page: string, request: Omit<DesignRenderRequest, 'html'>) {
  const bundle = await invoke<DesignFiles>('design_files', { chatId });
  const source = bundle.files[page];
  if (source === undefined || !/\.html?$/i.test(page)) {
    return { error: `No such page: ${page}. Pages: ${bundle.pages.join(', ') || '(none yet; write index.html first)'}` };
  }
  const built = buildPreviewHtml(source, bundle.files, page, true);
  const result = await invoke<DesignRenderResult>('design_render', { ...request, html: built.html });
  return { result, externalRefs: built.externalRefs };
}

/** A borrowed Home tool whose screenshot is dropped for a model that cannot see it; the reading still goes back. */
function withVisionGate(tool: AgentTool, host: DesignToolHost): AgentTool {
  return {
    ...tool,
    async execute(id, args, ctx) {
      const result = await tool.execute(id, args, ctx);
      if (!result.images?.length || (await host.vision())) return result;
      return { ...result, images: undefined, content: `${result.content}\n(Screenshot not attached: this model cannot see images. Read the page with browser_read or browser_snapshot.)` };
    }
  };
}

export function createDesignTools(host: DesignToolHost, borrowed: Map<string, AgentTool> = new Map()): Map<string, AgentTool> {
  const tools = new Map<string, AgentTool>();
  tools.set('design_3d', {
    ...DESIGN_3D_TOOL, executionMode: 'sequential',
    async execute(_id, args, ctx) {
      const action = asString(args.action);
      if (!['status', 'build', 'render'].includes(action)) return text('Use status, build or render.', true);
      if (ctx.signal.aborted) return text('Stopped.', true);
      const done = host.step('design_3d', action);
      host.count();
      // The turn owns cancellation; changing the visible space leaves the job running.
      const cancel = () => { if (action !== 'status') void invoke('design_3d', { chatId: host.chatId, action: 'cancel', owner: _id }).catch(() => {}); };
      ctx.signal.addEventListener('abort', cancel, { once: true });
      try {
        const state = await invoke<BlenderState>('design_3d', { chatId: host.chatId, action, scene: args.scene, render: args.render, owner: _id });
        done(!state.error, state.error);
        const summary = JSON.stringify({ available: state.available, busy: state.busy, model: state.model, render: state.render, scene: state.scene, error: state.error });
        if (action !== 'status' && state.render && !state.error && await host.vision()) {
          const image = await invoke<{ data: string; mimeType: string }>('design_3d', { chatId: host.chatId, action: 'asset', asset: 'render' });
          return { content: summary, images: [image] };
        }
        return text(summary, !!state.error);
      } catch (error) { done(false, String(error)); return text(String(error), true); }
      finally { ctx.signal.removeEventListener('abort', cancel); }
    }
  });

  const fileTool = (name: string) => async (_id: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const done = host.step(name, asString(args.path) || asString(args.label));
    host.count();
    try {
      const result = await invoke<DesignToolResult>('design_tool', { chatId: host.chatId, name, args });
      done(result.ok, result.ok ? undefined : result.content);
      return text(result.content, !result.ok);
    } catch (error) {
      done(false, String(error));
      return text(String(error), true);
    }
  };

  /** The page's state a render starts from: a hover or focus on a selector, a scroll. */
  const stateArgs = (args: Record<string, unknown>) => ({
    hover: asString(args.hover).trim() || undefined,
    focus: asString(args.focus).trim() || undefined,
    scrollTo: typeof args.scroll_to === 'number' ? args.scroll_to : undefined
  });

  const renderTool = (name: 'design_preview' | 'design_inspect') => async (_id: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const page = pageFrom(args.page);
    const inspect = name === 'design_inspect';
    const frames = !inspect && typeof args.frames === 'number' ? args.frames : undefined;
    const done = host.step(name, inspect ? asString(args.selector) : frames ? `${page} · ${frames} frames` : page);
    host.count();
    try {
      if (inspect && !asString(args.selector).trim()) { done(false, 'selector is required'); return text('selector is required.', true); }
      const sees = inspect ? false : await host.vision();
      const width = typeof args.width === 'number' ? args.width : undefined;
      const rendered = await render(host.chatId, page, {
        mode: inspect ? 'inspect' : frames !== undefined ? 'frames' : sees ? 'screenshot' : 'outline',
        width,
        height: typeof args.height === 'number' ? args.height : undefined,
        fullPage: args.full_page === true,
        selector: inspect ? asString(args.selector) : undefined,
        frames,
        durationMs: typeof args.duration_ms === 'number' ? args.duration_ms : undefined,
        withImages: sees,
        ...(inspect ? {} : stateArgs(args))
      });
      if ('error' in rendered && rendered.error) { done(false, rendered.error); return text(rendered.error, true); }
      const { result, externalRefs } = rendered as { result: DesignRenderResult; externalRefs: string[] };
      if (!result.ok) { done(false, result.error); return text(result.error || 'Rendering failed.', true); }
      done(true, result.consoleErrors.length ? `${result.consoleErrors.length} console error(s)` : undefined);
      const summary = renderSummary(page, result, externalRefs);
      if (inspect) return text(`${summary}\n${result.outline ?? ''}\n${JSON.stringify(result.matches ?? [], null, 1)}`);
      if (result.frames) {
        const film = sees ? await composeFilmstrip(result.frames) : null;
        if (film) return { content: `${summary}\nFilmstrip of ${result.frames.length} frames, left to right.`, images: [{ data: film.png, mimeType: 'image/png' }] };
        return text(`${summary}\n${result.outline ?? ''}`);
      }
      if (result.png) return { content: summary, images: [{ data: result.png, mimeType: 'image/png' }] };
      return text(`${summary}\n${result.outline ?? ''}`);
    } catch (error) {
      done(false, String(error));
      return text(String(error), true);
    }
  };

  /** Every animation and transition on a page, and which of them still run when the user prefers reduced motion. */
  const motionTool = async (_id: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const page = pageFrom(args.page);
    const done = host.step('design_motion', page);
    host.count();
    try {
      const rendered = await render(host.chatId, page, { mode: 'motion', hover: asString(args.hover).trim() || undefined, focus: asString(args.focus).trim() || undefined });
      if ('error' in rendered && rendered.error) { done(false, rendered.error); return text(rendered.error, true); }
      const { result, externalRefs } = rendered as { result: DesignRenderResult; externalRefs: string[] };
      if (!result.ok) { done(false, result.error); return text(result.error || 'Motion could not be read.', true); }
      done(true);
      return text(`${renderSummary(page, result, externalRefs)}\n${result.outline ?? ''}`);
    } catch (error) {
      done(false, String(error));
      return text(String(error), true);
    }
  };

  /** A public page, read by main in a private window: its reading comes back, and a picture only for a model that sees. */
  const referenceTool = async (_id: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const url = asString(args.url).trim();
    const done = host.step('design_reference', url);
    host.count();
    try {
      const result = await invoke<DesignReferenceResult>('design_reference', {
        chatId: host.chatId,
        url,
        width: typeof args.width === 'number' ? args.width : undefined,
        image: await host.vision(),
        saveScreenshot: args.save_screenshot === true,
        saveAsSystem: asString(args.save_as_system).trim() || undefined
      });
      if (!result.ok) { done(false, result.error); return text(result.error || 'The page could not be read.', true); }
      done(true);
      return result.image ? { content: result.text, images: [result.image] } : text(result.text);
    } catch (error) {
      done(false, String(error));
      return text(String(error), true);
    }
  };

  /** One image from references/ or assets/: the picture for a vision model, its size for the rest. */
  const viewTool = async (_id: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const path = asString(args.path).trim();
    const done = host.step('design_view', path);
    host.count();
    try {
      const image = await invoke<DesignImageResult>('design_view', { chatId: host.chatId, path });
      done(true);
      const label = `${image.path} (${Math.max(1, Math.round(image.bytes / 1024))} KB)`;
      if (!(await host.vision())) return text(`${label}. This model cannot see images, so the picture is not attached; work from the notes on it or ask the user to describe it.`);
      return { content: `${label}, attached.`, images: [{ data: image.data, mimeType: image.mimeType }] };
    } catch (error) {
      done(false, String(error));
      return text(String(error), true);
    }
  };

  for (const spec of DESIGN_TOOL_SPECS) {
    const execute = spec.name === 'design_motion' ? motionTool : spec.name === 'design_preview' || spec.name === 'design_inspect' ? renderTool(spec.name) : fileTool(spec.name);
    tools.set(spec.name, {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      // A render reads what the writes built, so it waits for them; so does anything that changes the workspace.
      executionMode: spec.name === 'design_list' || spec.name === 'design_read' ? 'parallel' : 'sequential',
      execute
    });
  }
  for (const spec of DESIGN_RESEARCH_TOOL_SPECS) {
    tools.set(spec.name, {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      // Viewing reads; reading a page may save a screenshot into the workspace, so it runs alone.
      executionMode: spec.name === 'design_view' ? 'parallel' : 'sequential',
      execute: spec.name === 'design_view' ? viewTool : referenceTool
    });
  }
  // Read-only Home tools: web search, and the agent browser's reading half. Nothing else is borrowed.
  for (const name of DESIGN_BORROWED_TOOLS) {
    const tool = borrowed.get(name);
    if (tool) tools.set(name, withVisionGate(tool, host));
  }
  return tools;
}
