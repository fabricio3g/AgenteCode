// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import ChartBlock from './ChartBlock.svelte';
afterEach(cleanup);
const raw = JSON.stringify({ labels: ['First', 'Second'], datasets: [{ label: 'Product', data: [10, 20] }, { label: 'Services', data: [3, 8] }] });
describe('chart interactions and existing payloads', () => {
  it('renders the existing bar format and allows hiding a series while retaining one', async () => {
    const view = render(ChartBlock, { props: { type: 'bar', title: 'Revenue', raw } });
    expect(view.container.querySelectorAll('svg:not(.ag-icon) rect')).toHaveLength(4);
    await fireEvent.click(view.getByRole('button', { name: 'Services' }));
    expect(view.container.querySelectorAll('svg:not(.ag-icon) rect')).toHaveLength(2);
    expect(view.getByRole('button', { name: 'Product' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.click(view.getByRole('button', { name: 'Services' }));
    expect(view.container.querySelectorAll('svg:not(.ag-icon) rect')).toHaveLength(4);
  });
  it('offers keyboard values and a data table for the complete series', async () => {
    const view = render(ChartBlock, { props: { type: 'line', title: 'Revenue', raw } });
    const inspect = view.getByRole('slider');
    await fireEvent.keyDown(inspect, { key: 'End' });
    expect(inspect.getAttribute('aria-valuetext')).toContain('Second: Product 20, Services 8');
    await fireEvent.click(view.getByRole('button', { name: 'Show chart data' }));
    expect(view.getByRole('table')).toBeTruthy();
    expect(view.getAllByRole('row')).toHaveLength(3);
  });
  it('reports invalid charts without offering a misleading export', () => {
    const view = render(ChartBlock, { props: { type: 'pie', raw: JSON.stringify({ labels: ['Loss'], datasets: [{ label: 'X', data: [-2] }] }) } });
    expect(view.getByRole('status').textContent).toMatch(/non-negative/);
    expect(view.getByRole('button', { name: 'Download chart as SVG' }).hasAttribute('disabled')).toBe(true);
  });
  it('cannot hide the last positive slice while a zero-valued category remains', () => {
    const view = render(ChartBlock, { props: { type: 'pie', raw: JSON.stringify({ labels: ['Positive', 'Zero'], datasets: [{ label: 'X', data: [2, 0] }] }) } });
    expect(view.getByRole('button', { name: 'Positive' }).hasAttribute('disabled')).toBe(true);
  });
});
