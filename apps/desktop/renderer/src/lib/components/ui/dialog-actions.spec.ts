// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DialogActions from './DialogActions.svelte';
import Textarea from './Textarea.svelte';
afterEach(cleanup);
describe('standard dialog actions and quiet composer', () => {
  it('uses equally sized outlined cancellation and solid destructive confirmation', async () => {
    const oncancel = vi.fn(); const onconfirm = vi.fn();
    const view = render(DialogActions, { props: { cancelLabel: 'Cancelar', confirmLabel: 'Eliminar', danger: true, oncancel, onconfirm } });
    const cancel = view.getByRole('button', { name: 'Cancelar' });
    const confirm = view.getByRole('button', { name: 'Eliminar' });
    expect(cancel.className).toContain('ui-button-outline');
    expect(confirm.className).toContain('bg-[var(--button-danger-bg)]');
    expect(confirm.className).toContain('text-[var(--button-danger-fg)]');
    expect(cancel.className).toContain('h-7'); expect(confirm.className).toContain('h-7');
    await fireEvent.click(cancel); expect(oncancel).toHaveBeenCalledOnce(); expect(onconfirm).not.toHaveBeenCalled();
    await fireEvent.click(confirm); expect(onconfirm).toHaveBeenCalledOnce();
  });
  it('disables a pending confirmation and retains its cancellation action', () => {
    const view = render(DialogActions, { props: { cancelLabel: 'Cancel', confirmLabel: 'Save', busy: true, busyLabel: 'Saving', oncancel: vi.fn(), onconfirm: vi.fn() } });
    expect((view.getByRole('button', { name: 'Saving' }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('preserves external form submission', () => {
    const view = render(DialogActions, { props: { cancelLabel: 'Cancel', confirmLabel: 'Create', confirmType: 'submit', form: 'new-project', oncancel: vi.fn() } });
    const confirm = view.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(confirm.type).toBe('submit'); expect(confirm.getAttribute('form')).toBe('new-project');
  });
  it('keeps composer textareas free of the form border, focus ring and background change', () => {
    const view = render(Textarea, { props: { variant: 'composer', 'aria-label': 'Message' } });
    const field = view.getByRole('textbox', { name: 'Message' });
    expect(field.className).toContain('border-0'); expect(field.className).toContain('bg-transparent');
    expect(field.className).toContain('ui-field-composer'); expect(field.className).not.toContain('focus-visible:ring-'); expect(field.className).not.toContain('focus-visible:border-ring');
    expect(field.className).not.toContain('focus-visible:bg-'); expect(field.className).not.toContain('min-h-20');
  });
});
