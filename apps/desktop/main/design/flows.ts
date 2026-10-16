/**
 * `flows.json`: the page links of a design. The renderer proposes a list; main
 * checks every link against the pages that exist and writes the file through
 * the same jail as every other workspace write.
 */
import { DESIGN_FLOWS_FILE, parseFlowLinks, parseFlows, serializeFlows, type DesignFlowLink } from '../../shared/design-flows.ts';
import { collectFiles, DesignPathError, writeText } from './workspace.ts';

/** Every page and variant entry the board can draw. */
function boardPages(root: string): string[] {
  const { pages, variants } = collectFiles(root);
  return [...pages, ...variants.map((variant) => variant.entry)];
}

/** The links on disk now, leniently read and pruned to pages that still exist. */
export function readFlows(root: string): DesignFlowLink[] {
  const { files } = collectFiles(root);
  return parseFlows(files[DESIGN_FLOWS_FILE], boardPages(root));
}

/** Replace the links. Anything malformed or pointing at a missing page refuses the whole write. */
export function setFlows(root: string, links: unknown): { path: string; links: DesignFlowLink[] } {
  let valid: DesignFlowLink[];
  try {
    valid = parseFlowLinks(links, boardPages(root), true);
  } catch (error) {
    throw new DesignPathError(error instanceof Error ? error.message : 'Invalid links.');
  }
  return { path: writeText(root, DESIGN_FLOWS_FILE, serializeFlows(valid)), links: valid };
}
