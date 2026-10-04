export const BROWSER_OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], .ui-modal-backdrop, [data-overlay], .sidebar-view-full.preview';
const WINDOWS = '.workspace-panel, [data-workspace-interacting]';
const RELEVANT = `${BROWSER_OVERLAYS}, ${WINDOWS}`;

/** Transcript streaming cannot change native-view exposure. Observe actual overlays. */
export function affectsBrowserPresentation(records: MutationRecord[], viewport?: HTMLElement): boolean {
  return records.some((record) => {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (!target) return false;
    if (record.type === 'attributes') {
      return target.matches(WINDOWS) || target.matches('.sidebar-view-full') || record.attributeName?.startsWith('data-workspace-') === true
        || !!target.closest(BROWSER_OVERLAYS) || !!viewport && target.contains(viewport);
    }
    return !!target.closest(BROWSER_OVERLAYS) || [...record.addedNodes, ...record.removedNodes].some((node) =>
      node instanceof Element && (node.matches(RELEVANT) || !!node.querySelector(RELEVANT) || !!viewport && node.contains(viewport))
    );
  });
}
