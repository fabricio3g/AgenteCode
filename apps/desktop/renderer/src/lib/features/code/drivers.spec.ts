import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverInfo } from '$shared/agente-protocol';

const bridge = vi.hoisted(() => ({
  invokes: [] as Array<{ command: string; args?: Record<string, unknown> }>,
  responses: {} as Record<string, unknown>
}));

vi.mock('$lib/services/bridge', () => ({
  isElectron: () => true,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    bridge.invokes.push({ command, args });
    const response = bridge.responses[command];
    return typeof response === 'function' ? (response as (innerArgs?: unknown) => unknown)(args) : response;
  }
}));

import {
  BUILTIN_AGENTE_DRIVER,
  clampModeForDriver,
  driverBadgeLabel,
  driverReadiness,
  driversStore,
  isExternalDriverId,
  sessionBadgeFor,
  supportedModesFor
} from './drivers.svelte';

function makeDriver(overrides: Partial<DriverInfo> = {}): DriverInfo {
  return {
    instance_id: 'claude',
    driver_kind: 'claude',
    label: 'Claude Code',
    builtin: true,
    enabled: true,
    status: 'ready',
    capabilities: {
      approvals: true,
      attachments: [],
      compact: false,
      cost: true,
      fork: false,
      mcp_injection: true,
      models: true,
      modes: ['plan', 'build', 'auto'],
      native_plan_cards: false,
      resume: true,
      rewind_conversation: false,
      session_import: false,
      steer: true,
      thinking: false,
      usage: true
    },
    ...overrides
  };
}

describe('drivers helpers', () => {
  it('detects external instance ids accurately', () => {
    expect(isExternalDriverId(undefined)).toBe(false);
    expect(isExternalDriverId(null)).toBe(false);
    expect(isExternalDriverId('')).toBe(false);
    expect(isExternalDriverId('agente')).toBe(false);
    expect(isExternalDriverId('claude')).toBe(true);
    expect(isExternalDriverId('codex-work')).toBe(true);
  });

  it('derives supported modes without emulating missing ones', () => {
    expect(supportedModesFor(BUILTIN_AGENTE_DRIVER)).toEqual(['plan', 'supervised', 'full']);
    const subset = makeDriver({
      capabilities: { ...makeDriver().capabilities, modes: ['build', 'auto'] }
    });
    expect(supportedModesFor(subset)).toEqual(['supervised', 'full']);
    expect(clampModeForDriver('plan', subset)).toBe('supervised');
    expect(clampModeForDriver('full', subset)).toBe('full');

    const empty = makeDriver({
      capabilities: { ...makeDriver().capabilities, modes: [] }
    });
    expect(supportedModesFor(empty)).toEqual([]);
  });

  it('reports readiness separately for agente core and external CLIs', () => {
    expect(driverReadiness(BUILTIN_AGENTE_DRIVER, false, 'agente')).toEqual({ ready: false, status: 'agente' });
    expect(driverReadiness(BUILTIN_AGENTE_DRIVER, true, 'agente')).toEqual({ ready: true, status: 'agente' });

    expect(driverReadiness(makeDriver({ status: 'ready', auth_hint: 'ignore when ready' }), false, 'claude')).toEqual({
      ready: true,
      status: 'ready',
      detail: undefined
    });
    expect(driverReadiness(makeDriver({ status: 'needs_auth', auth_hint: 'Run claude auth login' }), true, 'claude')).toEqual({
      ready: false,
      status: 'needs_auth',
      detail: 'Run claude auth login'
    });
    expect(driverReadiness(undefined, true, 'custom-acp')).toEqual({
      ready: false,
      status: 'missing'
    });
  });
});

describe('driversStore', () => {
  beforeEach(() => {
    driversStore.drivers = [BUILTIN_AGENTE_DRIVER];
    driversStore.loaded = false;
    driversStore.probedIds = {};
    driversStore.error = null;
    bridge.invokes.length = 0;
    bridge.responses = {
      agente_drivers_list: {
        drivers: [makeDriver({ instance_id: 'claude', status: 'ready' }), makeDriver({ instance_id: 'codex', driver_kind: 'codex', label: 'Codex', status: 'missing' })]
      },
      agente_drivers_probe: (args?: { instanceId?: string }) =>
        args?.instanceId
          ? { driver: makeDriver({ instance_id: args.instanceId, status: 'ready', version: '2.0.1' }) }
          : { drivers: [makeDriver({ instance_id: 'claude', status: 'ready', version: '2.0.0' })] },
      agente_drivers_save: (args: { instanceId: string; config: { label?: string } }) => ({
        driver: makeDriver({
          instance_id: args.instanceId,
          label: args.config.label || args.instanceId,
          builtin: false,
          status: 'ready'
        })
      }),
      agente_drivers_delete: { deleted: true }
    };
  });

  it('loads passive list keeping agente first, probes, saves, and deletes', async () => {
    const loaded = await driversStore.load(false);
    expect(loaded.map((d) => d.instance_id)).toEqual(['agente', 'claude', 'codex']);
    expect(driversStore.readyExternalCount).toBe(1);

    await driversStore.ensureProbed('claude');
    await driversStore.ensureProbed('claude');
    expect(bridge.invokes.filter((i) => i.command === 'agente_drivers_probe')).toHaveLength(1);

    await driversStore.probe('codex');
    expect(driversStore.byId('codex')?.status).toBe('ready');
    expect(driversStore.byId('codex')?.version).toBe('2.0.1');

    const saved = await driversStore.saveInstance('claude-work', { extends: 'claude', label: 'Claude Work' });
    expect(saved.instance_id).toBe('claude-work');
    expect(driversStore.byId('claude-work')?.label).toBe('Claude Work');

    const deleted = await driversStore.deleteInstance('claude-work');
    expect(deleted).toBe(true);
    expect(driversStore.byId('claude-work')).toBeUndefined();
  });

  it('builds sidebar and swarm badges cleanly from external instance and worktree metadata', async () => {
    await driversStore.load(false);
    expect(driverBadgeLabel(undefined)).toBeNull();
    expect(driverBadgeLabel('agente')).toBeNull();
    expect(driverBadgeLabel('claude')).toBe('Claude Code');
    expect(driverBadgeLabel('custom-agent')).toBe('custom-agent');

    expect(sessionBadgeFor({ codeAgent: { instanceId: 'agente' } })).toBe('');
    expect(sessionBadgeFor({ codeAgent: { instanceId: 'claude' } })).toBe('Claude Code');
    expect(
      sessionBadgeFor({
        codeAgent: {
          instanceId: 'claude',
          worktree: { branch: 'agente/wt-1' }
        }
      })
    ).toBe('Claude Code · wt');
    expect(
      sessionBadgeFor({
        codeAgent: {
          instanceId: 'agente',
          worktree: { branch: 'agente/wt-2' }
        }
      })
    ).toBe('wt');
  });
});
