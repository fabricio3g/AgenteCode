import type { DriverInfo, DriverInstanceConfig, DriverStatus, TurnMode } from '$shared/agente-protocol';
import { deleteDriverInstance, listDrivers, probeDrivers, saveDriverInstance } from './code-ipc';

export type CodeModeId = 'plan' | 'supervised' | 'full';

/** Built-in Agente Core descriptor available immediately before daemon discovery finishes. */
export const BUILTIN_AGENTE_DRIVER: DriverInfo = {
  instance_id: 'agente',
  driver_kind: 'agente',
  label: 'Agente Core',
  builtin: true,
  enabled: true,
  status: 'ready',
  capabilities: {
    approvals: true,
    attachments: ['image', 'audio', 'video', 'pdf'],
    compact: true,
    cost: true,
    fork: true,
    mcp_injection: true,
    models: true,
    modes: ['plan', 'build', 'auto'],
    native_plan_cards: true,
    resume: true,
    rewind_conversation: true,
    session_import: true,
    steer: true,
    thinking: true,
    usage: true
  }
};

const CANONICAL_MODES: readonly CodeModeId[] = ['plan', 'supervised', 'full'];

/** Map wire TurnMode values onto desktop Code mode ids. */
export function turnModeToCodeMode(mode: TurnMode): CodeModeId {
  if (mode === 'plan') return 'plan';
  if (mode === 'auto') return 'full';
  return 'supervised';
}

export function isExternalDriverId(instanceId?: string | null): boolean {
  return !!instanceId && instanceId !== 'agente';
}

export function driverBadgeLabel(instanceId?: string | null): string | null {
  if (!isExternalDriverId(instanceId)) return null;
  return driversStore.byId(instanceId)?.label || instanceId || null;
}

export function sessionBadgeFor(chat: {
  codeAgent?: { instanceId?: string | null; worktree?: { branch?: string } | null } | null;
}): string {
  const parts: string[] = [];
  const driver = driverBadgeLabel(chat.codeAgent?.instanceId);
  if (driver) parts.push(driver);
  if (chat.codeAgent?.worktree?.branch) parts.push('wt');
  return parts.join(' · ');
}

/** Return the permission modes honestly supported by a driver, in canonical display order. */
export function supportedModesFor(driver?: DriverInfo | null): CodeModeId[] {
  if (!driver || driver.instance_id === 'agente' || !driver.capabilities.modes) {
    return [...CANONICAL_MODES];
  }
  const allowed = new Set(driver.capabilities.modes.map(turnModeToCodeMode));
  return CANONICAL_MODES.filter((mode) => allowed.has(mode));
}

/** Clamp a requested mode onto the nearest mode supported by the selected driver. */
export function clampModeForDriver(mode: CodeModeId | undefined, driver?: DriverInfo | null): CodeModeId {
  const supported = supportedModesFor(driver);
  if (mode && supported.includes(mode)) return mode;
  if (supported.includes('supervised')) return 'supervised';
  return supported[0] ?? 'supervised';
}

export function driverReadiness(
  driver: DriverInfo | undefined,
  ownModelReady: boolean,
  instanceId?: string | null
): { ready: boolean; status: DriverStatus | 'agente'; detail?: string } {
  const id = instanceId ?? driver?.instance_id ?? 'agente';
  if (!isExternalDriverId(id)) {
    return { ready: ownModelReady, status: 'agente' };
  }
  if (!driver) {
    return { ready: false, status: 'missing' };
  }
  const detail =
    driver.status === 'error' || driver.status === 'needs_auth'
      ? driver.error || driver.auth_hint || undefined
      : undefined;
  return {
    ready: driver.status === 'ready',
    status: driver.status,
    detail
  };
}

function orderDrivers(list: DriverInfo[]): DriverInfo[] {
  const seen = new Set<string>();
  const out: DriverInfo[] = [];
  const builtin = list.find((item) => item.instance_id === 'agente') ?? BUILTIN_AGENTE_DRIVER;
  seen.add(builtin.instance_id);
  out.push(builtin);
  for (const item of list) {
    if (seen.has(item.instance_id)) continue;
    seen.add(item.instance_id);
    out.push(item);
  }
  return out;
}

class DriversStore {
  drivers = $state<DriverInfo[]>([BUILTIN_AGENTE_DRIVER]);
  loaded = $state(false);
  loading = $state(false);
  probingAll = $state(false);
  probingIds = $state<Record<string, boolean>>({});
  probedIds = $state<Record<string, boolean>>({});
  error = $state<string | null>(null);
  #inFlightLoad: Promise<DriverInfo[]> | null = null;

  get readyExternalCount(): number {
    return this.drivers.filter((driver) => isExternalDriverId(driver.instance_id) && driver.status === 'ready').length;
  }

  byId(instanceId?: string | null): DriverInfo | undefined {
    const target = instanceId || 'agente';
    return this.drivers.find((driver) => driver.instance_id === target) ?? (target === 'agente' ? BUILTIN_AGENTE_DRIVER : undefined);
  }

  async load(probe = false): Promise<DriverInfo[]> {
    if (!probe && this.#inFlightLoad) return this.#inFlightLoad;
    this.loading = true;
    this.error = null;
    const task = (async () => {
      try {
        const result = await listDrivers(probe);
        if (result.length) {
          this.drivers = orderDrivers(result);
        }
        this.loaded = true;
        return this.drivers;
      } catch (err: unknown) {
        this.error = err instanceof Error ? err.message : String(err);
        return this.drivers;
      } finally {
        this.loading = false;
        this.#inFlightLoad = null;
      }
    })();
    if (!probe) this.#inFlightLoad = task;
    return task;
  }

  async ensureProbed(instanceId: string): Promise<void> {
    if (!isExternalDriverId(instanceId)) return;
    if (this.probedIds[instanceId] || this.probingIds[instanceId]) return;
    const driver = this.byId(instanceId);
    if (!driver || driver.status === 'missing' || driver.status === 'disabled') return;
    await this.probe(instanceId);
  }

  async probe(instanceId?: string): Promise<DriverInfo[]> {
    this.error = null;
    if (instanceId) this.probingIds = { ...this.probingIds, [instanceId]: true };
    else this.probingAll = true;
    try {
      const updated = await probeDrivers(instanceId);
      if (updated.length) {
        if (!instanceId) {
          this.drivers = orderDrivers(updated);
          const nextProbed: Record<string, boolean> = {};
          for (const item of updated) {
            if (isExternalDriverId(item.instance_id)) nextProbed[item.instance_id] = true;
          }
          this.probedIds = nextProbed;
        } else {
          const map = new Map(this.drivers.map((driver) => [driver.instance_id, driver]));
          for (const item of updated) map.set(item.instance_id, item);
          this.drivers = orderDrivers([...map.values()]);
          this.probedIds = { ...this.probedIds, [instanceId]: true };
        }
        this.loaded = true;
      }
      return updated;
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
      return [];
    } finally {
      if (instanceId) {
        const next = { ...this.probingIds };
        delete next[instanceId];
        this.probingIds = next;
      } else {
        this.probingAll = false;
      }
    }
  }

  async saveInstance(instanceId: string, config: DriverInstanceConfig): Promise<DriverInfo> {
    const { driver } = await saveDriverInstance(instanceId, config);
    const map = new Map(this.drivers.map((item) => [item.instance_id, item]));
    map.set(driver.instance_id, driver);
    this.drivers = orderDrivers([...map.values()]);
    this.probedIds = {};
    this.loaded = true;
    void this.probe(driver.instance_id);
    return driver;
  }

  async deleteInstance(instanceId: string): Promise<boolean> {
    const { deleted } = await deleteDriverInstance(instanceId);
    if (deleted) {
      this.drivers = this.drivers.filter((driver) => driver.instance_id !== instanceId);
      this.probedIds = {};
    }
    return deleted;
  }
}

export const driversStore = new DriversStore();
