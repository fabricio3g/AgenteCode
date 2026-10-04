// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeWorkspace } from '$lib/features/code/workspace.svelte';
import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
import { groups, measureWorkspace, parseWorkspaceLayout } from './workspace-layout';
import WorkspaceFixture from './test-fixtures/WorkspaceFixture.svelte';

const terminal = vi.hoisted(() => ({ writes: [] as string[], disposed: vi.fn(), focus: vi.fn(), created: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options = {}; cols = 80; rows = 24;
  constructor() { terminal.created(); }
  loadAddon() {} open() {} onData() { return { dispose() {} }; }
  write(data: string) { terminal.writes.push(data); }
  focus() { terminal.focus(); } dispose() { terminal.disposed(); }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

async function movePointer(target: Element, options: MouseEventInit) {
  await fireEvent.pointerMove(target, options);
  await new Promise(resolve => requestAnimationFrame(resolve));
  await tick();
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: () => void) {} observe() { this.callback(); } disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() {} });
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
  vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId = 1; });
  workspaceLayout.layout = parseWorkspaceLayout('{"version":1}'); workspaceLayout.focused = ''; workspaceLayout.interacting = false;
  terminal.writes.length = 0; vi.clearAllMocks();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('stable workspace panel hosts', () => {
  it('preserves the xterm instance, scrollback and output attachment when moved, grouped and hidden', async () => {
    let write: ((data: string) => void) | undefined;
    const attach = vi.spyOn(codeWorkspace, 'attachTerminal').mockImplementation((_id, callback) => { write = callback; return () => {}; });
    workspaceLayout.show('browser'); workspaceLayout.show('terminal:test', 'bottom');
    const view = render(WorkspaceFixture); await tick();
    const host = view.container.querySelector('.terminal-host');
    write?.('before moving\r\n');
    flushSync(() => workspaceLayout.float('terminal:test', { x: 30, y: 30, width: 400, height: 300 }, { x: 0, y: 0, width: 1200, height: 800 }));
    flushSync(() => workspaceLayout.dock('terminal:test', 'right', groups(workspaceLayout.layout.right)[0].id, 'center'));
    flushSync(() => workspaceLayout.hide('terminal:test'));
    write?.('output while hidden\r\n');
    flushSync(() => workspaceLayout.show('terminal:test'));
    expect(view.container.querySelector('.terminal-host')).toBe(host);
    expect(terminal.created).toHaveBeenCalledTimes(1); expect(attach).toHaveBeenCalledTimes(1); expect(terminal.disposed).not.toHaveBeenCalled();
    expect(terminal.writes).toEqual(['before moving\r\n', 'output while hidden\r\n']); attach.mockRestore();
  });
  it('resizes outer regions with keyboard controls and restores a cancelled pointer resize', async () => {
    workspaceLayout.show('browser'); const view = render(WorkspaceFixture); await tick();
    const widthHandle = view.container.querySelector('.workspace-divider .resize-handle')!;
    const start = workspaceLayout.layout.rightWidth;
    await fireEvent.keyDown(widthHandle, { key: 'ArrowLeft' }); expect(workspaceLayout.layout.rightWidth).toBe(start + 16);
    const snapshot = JSON.stringify(workspaceLayout.layout);
    await fireEvent.pointerDown(widthHandle, { button: 0, clientX: 700, clientY: 200 });
    await movePointer(widthHandle, { clientX: 650, clientY: 200 });
    expect(workspaceLayout.layout.rightWidth).toBe(start + 66);
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(JSON.stringify(workspaceLayout.layout)).toBe(snapshot); expect(workspaceLayout.interacting).toBe(false);
  });
  it('resizes a docked top panel in both axes from the corner and cancels cleanly', async () => {
    workspaceLayout.show('changes'); workspaceLayout.show('browser');
    workspaceLayout.dock('browser', 'right', groups(workspaceLayout.layout.right).find((item) => item.panels.includes('changes'))!.id, 'bottom');
    const view = render(WorkspaceFixture); await tick();
    const corner = view.container.querySelector('.window-resize')!;
    const frame = view.container.querySelector('[data-workspace-panel="changes"]')!;
    const width = workspaceLayout.layout.rightWidth, height = parseFloat((frame as HTMLElement).style.height);
    const saved = JSON.stringify(workspaceLayout.layout);
    await fireEvent.pointerDown(corner, { button: 0, clientX: 740, clientY: 400 });
    // Native capture can be released while moving away from the corner.
    await movePointer(view.container, { clientX: 700, clientY: 460 });
    expect(workspaceLayout.layout.rightWidth).toBe(width + 40);
    expect(parseFloat((frame as HTMLElement).style.height)).toBeCloseTo(height + 60);
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(JSON.stringify(workspaceLayout.layout)).toBe(saved);
    expect(workspaceLayout.interacting).toBe(false);
  });
  it('resizes the docked top edge next to the toolbar without dragging the panel', async () => {
    workspaceLayout.show('changes'); const view = render(WorkspaceFixture); await tick();
    const frame = view.container.querySelector<HTMLElement>('[data-workspace-panel="changes"]')!;
    const handles = view.container.querySelectorAll('.workspace-divider .resize-handle');
    const top = handles[2];
    await fireEvent.pointerDown(top, { button: 0, clientX: 900, clientY: 3 });
    await movePointer(top, { clientX: 900, clientY: 23 });
    await movePointer(top, { clientX: 900, clientY: 43 });
    await movePointer(top, { clientX: 900, clientY: 63 });
    expect(frame.style.top).toBe('60px'); expect(frame.style.height).toBe('740px');
    expect(workspaceLayout.layout.floating).toHaveLength(0);
    await fireEvent.pointerUp(top);
    await fireEvent.keyDown(top, { key: 'ArrowUp' });
    expect(frame.style.top).toBe('44px'); expect(frame.style.height).toBe('756px');
  });
  it('starts resizing from the displayed width when the saved width is constrained', async () => {
    workspaceLayout.show('browser'); workspaceLayout.layout = { ...workspaceLayout.layout, rightWidth: 1000 };
    const view = render(WorkspaceFixture); await tick();
    const handle = view.container.querySelector('.workspace-divider .resize-handle')!;
    const displayed = measureWorkspace(workspaceLayout.layout, { x: 0, y: 0, width: 1200, height: 800 }, new Set(['browser'])).placements[0].rect.width;
    await fireEvent.pointerDown(handle, { button: 0, clientX: 320, clientY: 200 });
    await movePointer(handle, { clientX: 360, clientY: 200 });
    expect(workspaceLayout.layout.rightWidth).toBe(displayed - 40);
    await fireEvent.pointerUp(handle);
  });
  it('exposes all eight floating resize directions with larger corner targets', async () => {
    workspaceLayout.show('browser');
    workspaceLayout.float('browser', { x: 100, y: 100, width: 400, height: 300 }, { x: 0, y: 0, width: 1200, height: 800 });
    const view = render(WorkspaceFixture); await tick();
    expect(view.container.querySelectorAll('.window-resize')).toHaveLength(8);
    const corner = view.container.querySelector<HTMLElement>('.edge-se')!;
    expect(corner.style.width).toBe('24px'); expect(corner.style.height).toBe('24px');
    await fireEvent.pointerDown(corner, { button: 0, clientX: 500, clientY: 400 });
    await movePointer(corner, { clientX: 560, clientY: 450 });
    expect(workspaceLayout.layout.floating[0].rect).toEqual({ x: 100, y: 100, width: 460, height: 350 });
    await fireEvent.pointerUp(corner); expect(workspaceLayout.interacting).toBe(false);
  });
  it('shows a drop preview, docks a dragged terminal and cancels a later move', async () => {
    workspaceLayout.show('browser'); workspaceLayout.show('terminal:test', 'bottom');
    const view = render(WorkspaceFixture); await tick();
    const tab = view.getByRole('tab', { name: 'Terminal' });
    await fireEvent.pointerDown(tab, { button: 0, clientX: 200, clientY: 550 });
    await movePointer(tab, { clientX: 1000, clientY: 400 });
    expect(view.container.querySelector('.drop-preview')).not.toBeNull();
    await fireEvent.pointerUp(tab, { clientX: 1000, clientY: 400 });
    expect(groups(workspaceLayout.layout.right)[0].panels).toEqual(['browser', 'terminal:test']);
    const saved = JSON.stringify(workspaceLayout.layout);
    const movedTab = view.getByRole('tab', { name: 'Terminal' });
    await fireEvent.pointerDown(movedTab, { button: 0, clientX: 1000, clientY: 30 });
    await movePointer(movedTab, { clientX: 500, clientY: 100 });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(JSON.stringify(workspaceLayout.layout)).toBe(saved); expect(view.container.querySelector('.drag-ghost')).toBeNull();
  });
});
