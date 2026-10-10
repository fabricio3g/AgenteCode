// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ControlBindings from '../../../../tests/fixtures/ControlBindings.svelte';
import TabBar from './TabBar.svelte';
import SearchField from './SearchField.svelte';
import Progress from './Progress.svelte';
afterEach(cleanup);
describe('shared controls across screens', () => {
  it('preserves number, range, multiline, checkbox and file behavior and element focus', async () => {
    const callbacks = { onnumber: vi.fn(), onrange: vi.fn(), ontext: vi.fn(), onfile: vi.fn(), oncheck: vi.fn() };
    const view = render(ControlBindings, { props: callbacks });
    const count = view.getByRole('spinbutton', { name: 'Count' });
    await fireEvent.input(count, { target: { value: '12.5' } });
    expect(callbacks.onnumber).toHaveBeenLastCalledWith(12.5);
    await fireEvent.input(count, { target: { value: '' } });
    expect(callbacks.onnumber).toHaveBeenLastCalledWith(null);
    await fireEvent.input(view.getByRole('slider', { name: 'Volume' }), { target: { value: '8' } });
    expect(callbacks.onrange).toHaveBeenLastCalledWith(8);
    await fireEvent.input(view.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Two\nlines' } });
    expect(callbacks.ontext).toHaveBeenLastCalledWith('Two\nlines');
    await fireEvent.click(view.getByRole('checkbox', { name: 'Enabled' }));
    expect(callbacks.oncheck).toHaveBeenLastCalledWith(true);
    const file = new File(['report'], 'report.txt', { type: 'text/plain' });
    const picker = view.getByLabelText('Import') as HTMLInputElement;
    await fireEvent.change(picker, { target: { files: [file] } });
    expect(callbacks.onfile).toHaveBeenLastCalledWith(file);
    expect(picker.value).toBe('');
    await fireEvent.click(view.getByRole('button', { name: 'Focus count' }));
    expect(document.activeElement).toBe(count);
    const click = vi.spyOn(picker, 'click');
    await fireEvent.click(view.getByRole('button', { name: 'Open import' }));
    expect(click).toHaveBeenCalledOnce();
  });
  it('navigates tabs by keyboard, skips disabled tabs and preserves focus', async () => {
    const onchange = vi.fn();
    const view = render(TabBar, { props: { label: 'Documents', value: 'report', options: [{ value: 'report', label: 'Report' }, { value: 'unavailable', label: 'Unavailable', disabled: true }, { value: 'sheet', label: 'Sheet' }], onchange } });
    const report = view.getByRole('tab', { name: 'Report' });
    report.focus();
    await fireEvent.keyDown(report, { key: 'ArrowRight' });
    const sheet = view.getByRole('tab', { name: 'Sheet' });
    expect(onchange).toHaveBeenLastCalledWith('sheet');
    expect(sheet.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(sheet);
    await fireEvent.keyDown(sheet, { key: 'Home' });
    expect(document.activeElement).toBe(report);
    expect(report.getAttribute('tabindex')).toBe('0');
  });
  it('clears a search and keeps keyboard focus in the field', async () => {
    const view = render(SearchField, { props: { value: 'report', placeholder: 'Find files', clearLabel: 'Clear search' } });
    await fireEvent.click(view.getByRole('button', { name: 'Clear search' }));
    const field = view.getByRole('searchbox', { name: 'Find files' }) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
    expect(view.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });
  it('clamps progress and represents unknown progress without a false percentage', () => {
    const view = render(Progress, { props: { label: 'Download', value: 180 } });
    expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    view.unmount();
    const unknown = render(Progress, { props: { label: 'Download' } });
    expect(unknown.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  });
});
