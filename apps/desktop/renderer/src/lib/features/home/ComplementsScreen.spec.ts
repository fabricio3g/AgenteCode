// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { Complement } from '$shared/complements';
import ComplementsScreen from './ComplementsScreen.svelte';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('$lib/services/bridge', () => ({ invoke }));
afterEach(() => { cleanup(); invoke.mockReset(); });

it('connects a hosted server and lets the user pause or remove it', async () => {
  const github: Complement = {
    id: '0123456789ab', name: 'GitHub', transport: 'http', target: 'https://api.githubcopilot.com/mcp/',
    args: [], enabled: true, hasCredentials: false, status: 'connected', tools: 3, toolNames: ['list', 'search', 'read'],
  };
  invoke.mockResolvedValueOnce([]).mockResolvedValueOnce([github])
    .mockResolvedValueOnce([{ ...github, enabled: false, status: 'disabled', tools: 0 }]).mockResolvedValueOnce([]);
  render(ComplementsScreen);
  await fireEvent.click(await screen.findByRole('button', { name: 'Add complement' }));
  const form = await screen.findByRole('dialog');
  await fireEvent.input(within(form).getByLabelText('Service name'), { target: { value: github.name } });
  await fireEvent.input(within(form).getByLabelText('MCP endpoint'), { target: { value: github.target } });
  await fireEvent.submit(document.getElementById('complement-settings')!);
  expect(await screen.findByText('3 tools')).toBeTruthy();
  expect(invoke).toHaveBeenNthCalledWith(2, 'complements_change', {
    action: 'save', settings: { name: github.name, transport: github.transport, target: github.target, args: [] },
  });
  await fireEvent.click(screen.getByRole('switch', { name: 'GitHub' }));
  expect(await screen.findByText('Paused')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: /GitHub/ }));
  await fireEvent.click(screen.getByRole('button', { name: 'Remove complement' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Remove complement' }));
  expect(await screen.findByText('No services connected')).toBeTruthy();
});
