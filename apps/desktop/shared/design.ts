/**
 * The Design space's contract between the renderer and the main process:
 * what the agent can call, the limits on a workspace, and the shapes that
 * cross IPC. Main enforces every limit; the renderer only displays them.
 */

/** Files the agent may write: plain text a browser renders without a build step. */
export const DESIGN_TEXT_EXTENSIONS = ['html', 'htm', 'css', 'svg', 'js', 'mjs', 'json', 'md', 'txt'] as const;
/** Binary assets can sit in the workspace (the user adds them) but the agent never writes them. */
export const DESIGN_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] as const;
export const DESIGN_LIMITS = {
  /** One text file, in bytes. */
  fileBytes: 512 * 1024,
  /** Files in a workspace, versions excluded. */
  files: 400,
  /** Everything in a workspace, versions excluded. */
  totalBytes: 24 * 1024 * 1024,
  /** Snapshots kept per design; the oldest are pruned. */
  versions: 30,
  /** What one `design_read` returns before it truncates. */
  readChars: 60_000
} as const;

/** The folder inside a workspace that holds version snapshots; no tool reaches into it. */
export const DESIGN_VERSIONS_DIR = '.versions';
/** Where the agent keeps alternatives: `variants/<name>/index.html`. */
export const DESIGN_VARIANTS_DIR = 'variants';
export const DESIGN_ENTRY = 'index.html';
/**
 * Images the user attached or the agent saved while researching: the design
 * agent looks at them first (`design_view`). The agent never writes them as
 * text; main writes them, validated by their bytes.
 */
export const DESIGN_REFERENCES_DIR = 'references';
/** An image added to `references/` from a chat attachment. */
export const REFERENCE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** An image `design_view` returns to the model (vision models only take so much per image). */
export const VIEW_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The viewport `design_reference` renders at: phone-to-wide, default desktop. */
export const REFERENCE_WIDTH = { min: 320, max: 2560, fallback: 1440 } as const;

export type DesignFileTool = 'design_list' | 'design_read' | 'design_write' | 'design_edit' | 'design_snapshot';
export type DesignRenderTool = 'design_preview' | 'design_inspect' | 'design_motion';
/** Research: a public page read into tokens, and an image from the workspace. */
export type DesignResearchTool = 'design_reference' | 'design_view';
export type DesignToolName = DesignFileTool | DesignRenderTool | DesignResearchTool;

export const DESIGN_FILE_TOOLS: readonly DesignFileTool[] = ['design_list', 'design_read', 'design_write', 'design_edit', 'design_snapshot'];
export const DESIGN_RENDER_TOOLS: readonly DesignRenderTool[] = ['design_preview', 'design_inspect', 'design_motion'];
/**
 * Tools the Design agent may borrow from Home: read-only web access and the
 * read-only half of the agent browser (open, snapshot, read, tabs, screenshot).
 * Clicking, typing and pressing keys stay out: a design turn never drives a form.
 */
export const DESIGN_BORROWED_TOOLS = ['web_search', 'fetch_url', 'browser_open', 'browser_snapshot', 'browser_read', 'browser_tabs', 'browser_screenshot'] as const;
/** Tools that change the workspace, so core runs them one at a time. */
export const DESIGN_MUTATING_TOOLS: readonly string[] = ['design_write', 'design_edit', 'design_snapshot', 'design_reference'];

export interface DesignToolSpec {
  name: DesignToolName;
  description: string;
  parameters: Record<string, unknown>;
}

const str = (description: string) => ({ type: 'string', description });

/** The model-facing definitions; shared so a test can assert there is no shell or git in the set. */
export const DESIGN_TOOL_SPECS: readonly DesignToolSpec[] = [
  {
    name: 'design_list',
    description: 'List every file in the design workspace with its size. Call it first to see what exists.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'design_read',
    description: 'Read one text file from the design workspace (HTML, CSS, SVG, JS, JSON, Markdown). Paths are relative, like "index.html" or "variants/bold/index.html".',
    parameters: { type: 'object', properties: { path: str('Workspace-relative file path.') }, required: ['path'], additionalProperties: false }
  },
  {
    name: 'design_write',
    description: 'Create or fully replace a text file in the design workspace. Parent folders are created. Prefer design_edit for small changes to an existing file.',
    parameters: {
      type: 'object',
      properties: { path: str('Workspace-relative file path, e.g. "index.html", "tokens.css", "pricing.html".'), content: str('The complete file content.') },
      required: ['path', 'content'], additionalProperties: false
    }
  },
  {
    name: 'design_edit',
    description: 'Replace one exact piece of text in an existing file. Fails when old_text is missing or matches more than once unless replace_all is true.',
    parameters: {
      type: 'object',
      properties: {
        path: str('Workspace-relative file path.'),
        old_text: str('Exact text to replace, including whitespace.'),
        new_text: str('The replacement.'),
        replace_all: { type: 'boolean', description: 'Replace every occurrence.' }
      },
      required: ['path', 'old_text', 'new_text'], additionalProperties: false
    }
  },
  {
    name: 'design_snapshot',
    description: 'Save a named version of the whole design the user can restore later. Use it before a risky rewrite. A version is also saved automatically when your turn ends.',
    parameters: { type: 'object', properties: { label: str('Short label, e.g. "before dark mode".') }, additionalProperties: false }
  },
  {
    name: 'design_preview',
    description: 'Render a page of the design offline and look at it. Vision models get a screenshot; other models get a compact outline of the visible elements and their key styles. Also reports console errors. Use it to check your work before finishing. To check motion, pass frames (2 to 8) and duration_ms: the page is captured at evenly spaced instants of that span (one filmstrip for vision models, or the boxes, opacity and transforms that changed for other models). hover or focus put the page in that state first; scroll_to scrolls it.',
    parameters: {
      type: 'object',
      properties: {
        page: str('HTML file to render. Default "index.html".'),
        width: { type: 'number', description: 'Viewport width in px: 390 mobile, 834 tablet, 1440 desktop (default).' },
        height: { type: 'number', description: 'Viewport height in px. Default 900.' },
        full_page: { type: 'boolean', description: 'Capture the full scroll height (up to 4000px) instead of one viewport.' },
        frames: { type: 'integer', minimum: 2, maximum: 8, description: 'Capture this many frames across duration_ms, first at 0 and last at the end.' },
        duration_ms: { type: 'number', minimum: 1, maximum: 3000, description: 'The span the frames cover, in ms. Default 600.' },
        hover: str('CSS selector to hover before capturing, so its transition plays.'),
        focus: str('CSS selector to focus before capturing.'),
        scroll_to: { type: 'number', description: 'Scroll to this y offset in px before capturing.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'design_motion',
    description: 'List every animation and transition on a page: its target, the properties it changes, duration, delay, easing and iterations. Reads the page after it loads, or after hover or focus on a selector, so a hover transition shows. It also renders the page once with prefers-reduced-motion: reduce and reports the animations that still run, so you can see what ignores the user setting.',
    parameters: {
      type: 'object',
      properties: {
        page: str('HTML file to read. Default "index.html".'),
        hover: str('CSS selector to hover first, so the transitions it starts are listed.'),
        focus: str('CSS selector to focus first.')
      },
      additionalProperties: false
    }
  },
  {
    name: 'design_inspect',
    description: 'Measure elements of a rendered page: their box (x, y, width, height), computed styles, and text, for a CSS selector. Use it to check spacing, overflow, contrast and alignment.',
    parameters: {
      type: 'object',
      properties: {
        selector: str('CSS selector, e.g. ".hero h1" or "button.primary".'),
        page: str('HTML file to render. Default "index.html".'),
        width: { type: 'number', description: 'Viewport width in px. Default 1440.' }
      },
      required: ['selector'], additionalProperties: false
    }
  }
];

/** The research tools. Main does the work: a page is read in a private window, an image is read from the workspace. */
export const DESIGN_RESEARCH_TOOL_SPECS: readonly DesignToolSpec[] = [
  {
    name: 'design_reference',
    description: 'Study a public web page: it is opened in a private window and you get its palette, font families, type scale, spacing, radii, shadows and layout notes, plus a screenshot when you can see images. Use it when the user names a product, site or style to borrow from. Borrow structure, rhythm and principles; never copy logos, copy or imagery. save_screenshot keeps the PNG in references/. save_as_system saves the extracted tokens as a design system under that name.',
    parameters: {
      type: 'object',
      properties: {
        url: str('Public http(s) page URL.'),
        width: { type: 'number', description: `Viewport width in px, ${REFERENCE_WIDTH.fallback} by default (${REFERENCE_WIDTH.min} to ${REFERENCE_WIDTH.max}).` },
        save_screenshot: { type: 'boolean', description: 'Keep the screenshot as references/<host>-<n>.png.' },
        save_as_system: str('Name for a design system made from the extracted tokens. Leave out to only read the page.')
      },
      required: ['url'], additionalProperties: false
    }
  },
  {
    name: 'design_view',
    description: 'Look at an image in the design workspace: a reference (references/) or an asset (assets/), as PNG, JPEG, WebP or GIF. Vision models see the image; other models get its size only. Look at the references the user attached before you design.',
    parameters: {
      type: 'object',
      properties: { path: str('Workspace path, e.g. "references/stripe-com-1.png".') },
      required: ['path'], additionalProperties: false
    }
  }
];

/** What `design_tool` returns for the file tools. */
export interface DesignToolResult {
  ok: boolean;
  /** The text the model reads. */
  content: string;
  /** Workspace paths that changed, for the canvas to reload. */
  changed?: string[];
}

export interface DesignFileEntry { path: string; size: number }
export interface DesignVersion { id: number; createdAt: number; label: string; auto: boolean; files: number }
export interface DesignVariant { name: string; entry: string }
export interface DesignFiles {
  /** Text files verbatim; images as data URLs, so the preview builder can inline them. */
  files: Record<string, string>;
  /** Top-level HTML pages (variants excluded), entry first. */
  pages: string[];
  variants: DesignVariant[];
}

export type DesignRenderMode = 'screenshot' | 'outline' | 'inspect' | 'frames' | 'motion';
export interface DesignRenderRequest {
  /** A complete document, already inlined by the preview builder. */
  html: string;
  mode: DesignRenderMode;
  width?: number;
  height?: number;
  fullPage?: boolean;
  selector?: string;
  /** frames: how many captures, across how many ms. */
  frames?: number;
  durationMs?: number;
  /** States to put the page in before capturing: hover or focus a selector, scroll to a y offset. */
  hover?: string;
  focus?: string;
  scrollTo?: number;
  /** frames: keep a picture of each frame (a vision model needs them; a text reader only needs the samples). */
  withImages?: boolean;
}

/** A motion capture: the element boxes, opacities and transforms at one instant. */
export interface DesignMotionSample {
  selector: string;
  box: { x: number; y: number; width: number; height: number };
  opacity: string;
  transform: string;
}
export interface DesignFrame {
  /** Milliseconds from the start of the capture. */
  t: number;
  /** Base64 PNG of the page at that instant. */
  png: string;
  samples: DesignMotionSample[];
}

/** One animation or transition on a page, as the page's own animation list reports it. */
export interface DesignAnimation {
  selector: string;
  kind: 'transition' | 'animation' | 'script';
  /** The keyframed properties, or the CSS animation's name. */
  name: string;
  properties: string[];
  durationMs: number;
  delayMs: number;
  /** A count, or 'infinite'. */
  iterations: number | 'infinite';
  easing: string;
  playState: string;
}

export interface DesignRenderResult {
  ok: boolean;
  error?: string;
  /** Base64 PNG, for `screenshot`. */
  png?: string;
  width: number;
  height: number;
  /** Compact text outline of the rendered page, for `outline`. */
  outline?: string;
  /** Matches for `inspect`. */
  matches?: unknown[];
  consoleErrors: string[];
  /** Captures for `frames`, in time order. */
  frames?: DesignFrame[];
  /** Every animation on the page, for `motion`. */
  animations?: DesignAnimation[];
  /** For `motion`: the animations still running with the page set to prefers-reduced-motion: reduce. */
  reducedRunning?: DesignAnimation[];
}

export type DesignManageRequest =
  | { chatId: string; action: 'versions' }
  | { chatId: string; action: 'snapshot'; label?: string; auto?: boolean }
  | { chatId: string; action: 'restore'; version: number }
  | { chatId: string; action: 'promote'; variant: string }
  /** Delete a top-level page or a `variants/<name>/index.html` variant (never the entry page); a version is saved first. */
  | { chatId: string; action: 'remove'; page: string }
  | { chatId: string; action: 'reveal' }
  /** Save the page's inlined HTML through a save dialog. */
  | { chatId: string; action: 'export'; page: string; html: string }
  /** Write the inlined HTML to a temp file and open it in the default browser. */
  | { chatId: string; action: 'open_external'; page: string; html: string }
  /** Copy an image the user attached into `references/`. `data` is base64 (a data URL is accepted). */
  | { chatId: string; action: 'add_reference'; name: string; data: string };

/** What `add_reference` answers: where the image is, and whether an identical one was already there. */
export interface DesignReferenceAdded { path: string; existed: boolean }

/** `design_reference`: read a public page. Only what the agent needs comes back; main never returns the page itself. */
export interface DesignReferenceRequest {
  chatId: string;
  url: string;
  width?: number;
  /** Capture a screenshot for the reply (the model can see images). */
  image?: boolean;
  /** Keep the screenshot as `references/<host>-<n>.png`. */
  saveScreenshot?: boolean;
  /** Build a design system with this name from the extracted tokens. */
  saveAsSystem?: string;
}

export interface DesignReferenceResult {
  ok: boolean;
  error?: string;
  /** The compact reading the model gets: palette, fonts, type, spacing, radii, shadows, layout. */
  text: string;
  /** A JPEG of the viewport, when `image` was requested. */
  image?: { data: string; mimeType: string };
  /** The workspace path of the saved screenshot. */
  saved?: string;
  /** The design system made from the page, when `saveAsSystem` was given. */
  system?: { id: string; name: string };
}

/** `design_view`: one image from the workspace, as the model reads it. */
export interface DesignImageResult { path: string; mimeType: string; data: string; bytes: number }

/** Pushed from main whenever a workspace changes (an agent write, a restore, a promote). */
export interface DesignChangedEvent { chatId: string; paths: string[] }

/** The canvas's pointer mode: browse the page as-is, pick elements, or pin comments. */
export type DesignCanvasTool = 'browse' | 'select' | 'comment' | 'draw';

/** An element the user picked on the canvas, as the picker script reports it. */
export interface DesignPick {
  /** A unique CSS selector inside the page (id when unique, else a short path). */
  selector: string;
  tag: string;
  /** Visible text, collapsed and capped at 140 characters. */
  text: string;
  /** outerHTML, capped at 1500 characters. */
  html: string;
  /** Page coordinates (not viewport), in CSS px at the viewport's width. */
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

export interface DesignSelection extends DesignPick {
  id: string;
  page: string;
  /** The width of the canvas frame it was picked in (the board can show a page at several). */
  width?: number;
}

/** A freehand mark drawn over a frame. `points` are page coordinates, so the mark follows the page's scroll. */
export interface DesignStroke {
  id: string;
  page: string;
  /** The width of the canvas frame it was drawn on; its mark shows only on that frame. */
  width?: number;
  points: { x: number; y: number }[];
  /** Selectors of the elements the mark crosses, most-crossed first; filled in by the frame after the mark is drawn. */
  hits?: string[];
}

/** A note pinned to a point on a page. `x`/`y` are page coordinates. */
export interface DesignComment {
  id: string;
  page: string;
  selector: string;
  x: number;
  y: number;
  note: string;
  /** The width of the canvas frame it was pinned in; its pin shows only on that frame. */
  width?: number;
}

/**
 * A design system: a reusable folder of tokens, guidance and an optional
 * specimen page. Its files are `tokens.css`, `DESIGN.md`, `components.html`
 * and `assets/`; `system.json` is its manifest and never reaches the agent.
 */
export const DESIGN_SYSTEM_MANIFEST = 'system.json';
export const DESIGN_SYSTEM_SPECIMEN = 'components.html';

export interface DesignSystemSummary {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** Saved from a design, or imported from a project folder. */
  origin: 'design' | 'folder';
  hasTokens: boolean;
  hasSpecimen: boolean;
}

/** A system with its text and image files, the way the canvas previews a design. */
export interface DesignSystemDetail extends DesignSystemSummary {
  files: DesignFiles;
}

/** What the design agent is briefed with: the system the design uses, read from the library. */
export interface DesignSystemBrief {
  name: string;
  designMd: string;
  tokens: string;
}

export type DesignSystemRequest =
  | { action: 'list' }
  | { action: 'get'; id: string }
  /** Save a design's tokens, guidance and specimen as a new system. */
  | { action: 'create'; chatId: string; name: string; description?: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'delete'; id: string }
  /** Copy a system's files into the design (after a snapshot) and link the design to it. */
  | { action: 'apply'; chatId: string; id: string }
  | { action: 'unlink'; chatId: string }
  | { action: 'current'; chatId: string }
  | { action: 'brief'; chatId: string }
  /** Pick a project folder and build a system from its tokens. */
  | { action: 'import' };

/** One page of a handoff bundle: its name and the inlined single-file HTML. */
export interface DesignHandoffPage { name: string; html: string }

/**
 * Handoff, through `design_handoff`. `bundle` saves a zip through a save
 * dialog; `deliver` copies the design into a project's `.agente/designs/`
 * (the renderer only sends it after the user confirmed in the dialog).
 */
export type DesignHandoffRequest =
  | { chatId: string; action: 'bundle'; title: string; handoff: string; pages: DesignHandoffPage[] }
  | { chatId: string; action: 'deliver'; title: string; handoff: string; projectRoot: string };

export type DesignHandoffResult =
  | { saved: boolean; path?: string }
  | { slug: string; dir: string; files: number };
