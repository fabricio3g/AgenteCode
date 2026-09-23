// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { modalLayer, openModalLayerCount } from './modal-layer';
import { placePanel, pointRect } from './menu';

function layerWith(buttons: string[]) {
  const node = document.createElement('div');
  for (const label of buttons) {
    const button = document.createElement('button');
    button.textContent = label;
    node.appendChild(button);
  }
  document.body.appendChild(node);
  return node;
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('modalLayer', () => {
  it('lets only the topmost layer handle Escape', async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    const outer = modalLayer(layerWith(['a']), { onclose: outerClose });
    const inner = modalLayer(layerWith(['b']), { onclose: innerClose });
    await flush();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();

    inner.destroy();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(outerClose).toHaveBeenCalledTimes(1);
    outer.destroy();
    expect(openModalLayerCount()).toBe(0);
  });

  it('skips Escape that a control inside already handled', async () => {
    const onclose = vi.fn();
    const layer = modalLayer(layerWith(['a']), { onclose });
    await flush();
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onclose).not.toHaveBeenCalled();
    layer.destroy();
  });

  it('stacks z-index by depth and restores focus and scroll on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const node = layerWith(['first', 'second']);
    const layer = modalLayer(node, {});
    await flush();
    expect(node.style.zIndex).toBe('calc(var(--z-modal) + 0)');
    expect(document.activeElement?.textContent).toBe('first');
    expect(document.body.style.overflow).toBe('hidden');

    layer.destroy();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('');
  });
});

describe('placePanel', () => {
  const viewport = { width: 800, height: 600 };

  it('opens below the anchor and flips up near the bottom edge', () => {
    expect(placePanel(pointRect(100, 100), { width: 200, height: 150 }, 'bottom-start', viewport)).toEqual({ top: 106, left: 100 });
    expect(placePanel(pointRect(100, 560), { width: 200, height: 150 }, 'bottom-start', viewport).top).toBe(404);
  });

  it('keeps the panel inside the viewport horizontally', () => {
    expect(placePanel(pointRect(780, 100), { width: 200, height: 50 }, 'bottom-start', viewport).left).toBe(594);
  });
});
