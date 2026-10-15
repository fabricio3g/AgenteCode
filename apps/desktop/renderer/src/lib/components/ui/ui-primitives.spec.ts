// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Button from './Button.svelte';
import Disclosure from './Disclosure.svelte';
import Input from './Input.svelte';
import SegmentedControl from './SegmentedControl.svelte';
import Select from './Select.svelte';
import Switch from './Switch.svelte';
import { reducedMotion } from '$lib/utils/motion.svelte';
import { motionSlide } from '$lib/utils/transitions';

afterEach(cleanup);

describe('settings UI primitives', () => {
  it('supports button loading and disabled states', () => {
    const view = render(Button, { props: { loading: true, loadingLabel: 'Saving' } });
    const button = view.getByRole('button', { name: 'Saving' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('renders borderless surface form controls with neutral focus rings', () => {
    const inputView = render(Input, { props: { variant: 'surface', 'aria-label': 'Search' } });
    const input = inputView.getByRole('textbox', { name: 'Search' });
    expect(input.className).toContain('border-0');
    expect(input.className).toContain('bg-[var(--card)]');
    expect(input.className).toContain('focus-visible:bg-[var(--surface-hover)]');
    expect(input.className).not.toContain('focus-visible:ring');
    inputView.unmount();

    const selectView = render(Select, {
      props: {
        variant: 'surface',
        'aria-label': 'Sort',
        options: [{ value: 'likes', label: 'Most liked' }],
      },
    });
    const select = selectView.getByRole('combobox', { name: 'Sort' });
    expect(select.className).toContain('border-0');
    expect(select.className).toContain('bg-[var(--card)]');
    expect(select.className).toContain('focus-visible:bg-[var(--surface-hover)]');
    expect(select.className).not.toContain('focus-visible:ring');
  });

  it('selects animated listbox options and reports the new value', async () => {
    const onchange = vi.fn();
    const view = render(Select, {
      props: {
        value: 'medium',
        'aria-label': 'Reasoning effort',
        onchange,
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium', description: 'Balanced' },
          { value: 'high', label: 'High' },
        ],
      },
    });
    const trigger = view.getByRole('combobox', { name: 'Reasoning effort' });
    expect(trigger.textContent).toContain('Medium');
    await fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const high = await view.findByRole('option', { name: 'High' });
    await fireEvent.click(high);
    expect(onchange).toHaveBeenCalledWith('high');
    expect(trigger.textContent).toContain('High');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('supports keyboard navigation, disabled-option skipping, and Escape', async () => {
    const view = render(Select, {
      props: {
        value: 'low',
        'aria-label': 'Quality',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium', disabled: true },
          { value: 'high', label: 'High' },
        ],
      },
    });
    const trigger = view.getByRole('combobox', { name: 'Quality' });
    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const activeId = trigger.getAttribute('aria-activedescendant');
    expect(activeId).toContain('option-2');
    await fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(trigger.textContent).toContain('High');

    await fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('toggles a switch with accessible state', async () => {
    const view = render(Switch, { props: { label: 'Web search', checked: false } });
    const control = view.getByRole('switch', { name: 'Web search' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    await fireEvent.click(control);
    expect(control.getAttribute('aria-checked')).toBe('true');
  });

  it('changes segmented selections', async () => {
    const view = render(SegmentedControl, {
      props: {
        label: 'Voice mode',
        value: 'tts',
        options: [
          { value: 'tts', label: 'Text to speech' },
          { value: 'stt', label: 'Speech to text' },
        ],
      },
    });
    const speechToText = view.getByRole('radio', { name: 'Speech to text' });
    await fireEvent.click(speechToText);
    expect(speechToText.getAttribute('aria-checked')).toBe('true');
  });

  it('uses tab semantics and arrow navigation for sliding tabs', async () => {
    const view = render(SegmentedControl, {
      props: {
        id: 'model-tabs',
        variant: 'tabs',
        label: 'Model hub sections',
        value: 'curated',
        options: [
          { value: 'curated', label: 'Curated' },
          { value: 'downloaded', label: 'Downloaded' },
          { value: 'search', label: 'Search' },
        ],
      },
    });
    const curated = view.getByRole('tab', { name: 'Curated' });
    const downloaded = view.getByRole('tab', { name: 'Downloaded' });
    curated.focus();
    await fireEvent.keyDown(curated, { key: 'ArrowRight' });
    expect(downloaded.getAttribute('aria-selected')).toBe('true');
    expect(downloaded.getAttribute('aria-controls')).toBe('model-tabs-panel-downloaded');
    expect(document.activeElement).toBe(downloaded);
  });

  it('opens disclosures and removes movement for reduced motion', async () => {
    const view = render(Disclosure, {
      props: { title: 'Advanced', children: (() => 'Manual URL') as never },
    });
    const trigger = view.getByRole('button', { name: /Advanced/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    reducedMotion.value = true;
    const config = motionSlide(document.createElement('div'), { duration: 180 });
    expect(config.duration).toBe(0);
    reducedMotion.value = false;
  });
});
