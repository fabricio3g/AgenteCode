<svelte:options runes={true} />

<!--
  External CLIs & profiles (`~/.agente/drivers.json`): passive probe status,
  multi-account `extends` profiles (`strip_env` / env overrides), and custom
  ACP-compatible coding agent binaries.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Badge, Button, Dialog, DialogActions, Input, Select, Switch, Textarea } from '$lib/components/ui';
  import { ChevronDown, Copy, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from '$lib/icons';
  import SettingsPage from './SettingsPage.svelte';
  import SettingsRow from './SettingsRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { driverBadgeLabel, driversStore } from '$lib/features/code/drivers.svelte';
  import DriverIcon from '$lib/features/code/DriverIcon.svelte';
  import { orchestratorStatus, orchestratorTasks } from '$lib/features/code/code-ipc';
  import { toastStore } from '$lib/stores/toast.svelte';
  import type { DriverInfo, DriverInstanceConfig, DriverStatus, OrchestratorStatus, OrchestratorTaskSummary } from '$shared/agente-protocol';

  const INSTANCE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

  let orch = $state<OrchestratorStatus | null>(null);
  let tasks = $state<OrchestratorTaskSummary[]>([]);
  let refreshingOrch = $state(false);
  let expandedModels = $state<Record<string, boolean>>({});
  let deleteConfirmId = $state<string | null>(null);
  let deletingId = $state<string | null>(null);

  // Add / edit dialog state
  let modalOpen = $state(false);
  let editingExisting = $state(false);
  let formMode = $state<'extends' | 'acp'>('extends');
  let formId = $state('');
  let formLabel = $state('');
  let formBaseId = $state('claude');
  let formCommand = $state('');
  let formArgs = $state('');
  let formEnv = $state('');
  let formStripEnv = $state('');
  let formUseFor = $state('');
  let formEnabled = $state(true);
  let formError = $state('');
  let saving = $state(false);

  const externalDrivers = $derived(driversStore.drivers.filter((d) => d.instance_id !== 'agente'));
  const installedDrivers = $derived(externalDrivers.filter((d) => d.status !== 'missing' || !d.builtin));
  const availableDrivers = $derived(externalDrivers.filter((d) => d.status === 'missing' && d.builtin));
  const editingDriver = $derived(editingExisting ? driversStore.byId(formId) : undefined);
  const baseCliOptions = $derived.by(() => {
    const builtins = externalDrivers
      .filter((d) => d.builtin)
      .map((d) => ({ value: d.instance_id, label: `${d.label} (${d.instance_id})` }));
    return builtins.length
      ? builtins
      : [
          { value: 'claude', label: 'Claude Code (claude)' },
          { value: 'codex', label: 'Codex (codex)' }
        ];
  });

  async function refreshOrchestrator() {
    if (refreshingOrch) return;
    refreshingOrch = true;
    try {
      const [status, list] = await Promise.all([
        orchestratorStatus().catch(() => null),
        orchestratorTasks().catch(() => [])
      ]);
      orch = status;
      tasks = list;
    } finally {
      refreshingOrch = false;
    }
  }

  function toggleModels(instanceId: string) {
    expandedModels = { ...expandedModels, [instanceId]: !expandedModels[instanceId] };
  }

  onMount(() => {
    void driversStore.load(false);
    void refreshOrchestrator();
  });

  function badgeTone(status: DriverStatus): 'neutral' | 'success' | 'warning' | 'error' {
    if (status === 'ready') return 'success';
    if (status === 'needs_auth') return 'warning';
    if (status === 'error') return 'error';
    return 'neutral';
  }

  function capabilitiesSummary(driver: DriverInfo): string {
    const parts: string[] = [];
    const caps = driver.capabilities;
    if (caps.modes?.length) {
      parts.push(caps.modes.map((m) => (m === 'build' ? 'supervised' : m === 'auto' ? 'auto' : 'plan')).join(' · '));
    }
    if (caps.steer) parts.push('steer');
    if (caps.resume) parts.push('resume');
    if (caps.mcp_injection) parts.push('MCP');
    return parts.join(' · ');
  }

  function descriptionFor(driver: DriverInfo): string {
    const modelCount = driver.models?.length
      ? $t('externalClis.modelCount', { values: { n: driver.models.length } })
      : null;
    const meta = [driver.binary_path, driver.version, modelCount].filter(Boolean).join(' · ');
    const caps = capabilitiesSummary(driver);
    return [meta, driver.use_for, caps].filter(Boolean).join(' — ');
  }

  function rowErrorFor(driver: DriverInfo): string | undefined {
    if (driver.status === 'error') return driver.error || undefined;
    if (driver.status === 'needs_auth') return driver.auth_hint || driver.error || undefined;
    return undefined;
  }

  async function probeAll() {
    await driversStore.probe();
  }

  async function probeOne(instanceId: string) {
    await driversStore.probe(instanceId);
  }

  function openNewDialog(baseId?: string) {
    editingExisting = false;
    formMode = baseId ? 'extends' : (baseCliOptions.length ? 'extends' : 'acp');
    formId = baseId ? `${baseId}-work` : '';
    formLabel = baseId ? `${driversStore.byId(baseId)?.label || baseId} (Work)` : '';
    formBaseId = baseId || baseCliOptions[0]?.value || 'claude';
    formCommand = '';
    formArgs = '';
    formEnv = '';
    formStripEnv = '';
    formUseFor = '';
    formEnabled = true;
    formError = '';
    modalOpen = true;
  }

  function openEditDialog(driver: DriverInfo) {
    const cfg = driver.config;
    editingExisting = true;
    formMode = cfg?.extends ? 'extends' : (driver.driver_kind === 'acp' && !driver.builtin ? 'acp' : 'extends');
    formId = driver.instance_id;
    formLabel = cfg?.label ?? driver.label;
    formBaseId = cfg?.extends || (
      driver.builtin
        ? driver.instance_id
        : externalDrivers.find((d) => d.builtin && d.driver_kind === driver.driver_kind)?.instance_id ?? 'claude'
    );
    formCommand = cfg?.command?.join(' ') ?? (!driver.builtin && driver.driver_kind === 'acp' ? (driver.binary_path ?? '') : '');
    formArgs = cfg?.args?.join(' ') ?? '';
    formEnv = Object.entries(cfg?.env ?? {})
      .map(([key, val]) => `${key}=${val}`)
      .join('\n');
    formStripEnv = (cfg?.strip_env ?? []).join(', ');
    formUseFor = cfg?.use_for ?? driver.use_for ?? '';
    formEnabled = cfg?.enabled ?? driver.enabled ?? true;
    formError = '';
    modalOpen = true;
  }

  function splitTokens(raw: string): string[] {
    return raw.trim().split(/\s+/).filter(Boolean);
  }

  function parseEnvLines(raw: string): { env: Record<string, string>; error?: string } {
    const env: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) {
        return { env, error: $t('externalClis.error.badEnvLine', { values: { line: trimmed } }) };
      }
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1);
      if (!key) return { env, error: $t('externalClis.error.badEnvLine', { values: { line: trimmed } }) };
      env[key] = val;
    }
    return { env };
  }

  async function saveForm() {
    if (saving) return;
    const id = formId.trim();
    if (!INSTANCE_ID_RE.test(id) || id === 'agente') {
      formError = $t('externalClis.error.badId');
      return;
    }
    const { env, error: envError } = parseEnvLines(formEnv);
    if (envError) {
      formError = envError;
      return;
    }
    const commandTokens = splitTokens(formCommand);
    const argTokens = splitTokens(formArgs);
    if (formMode === 'acp' && !editingExisting && !commandTokens.length) {
      formError = $t('externalClis.error.commandRequired');
      return;
    }
    const stripEnv = formStripEnv
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    const config: DriverInstanceConfig = {
      ...(editingExisting
        ? (editingDriver?.builtin
            ? {}
            : (formMode === 'extends'
                ? { extends: formBaseId }
                : { driver_kind: editingDriver?.driver_kind ?? 'acp' }))
        : (formMode === 'extends' ? { extends: formBaseId } : { driver_kind: 'acp' })),
      ...(formLabel.trim() ? { label: formLabel.trim() } : {}),
      enabled: formEnabled,
      ...(commandTokens.length ? { command: commandTokens } : {}),
      ...(argTokens.length ? { args: argTokens } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(stripEnv.length ? { strip_env: stripEnv } : {}),
      ...(formUseFor.trim() ? { use_for: formUseFor.trim() } : {})
    };

    saving = true;
    formError = '';
    try {
      const saved = await driversStore.saveInstance(id, config);
      modalOpen = false;
      toastStore.success($t('externalClis.saved', { values: { name: saved.label } }));
    } catch (error) {
      formError = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
    }
  }

  async function deleteInstance(id: string) {
    if (deletingId) return;
    deletingId = id;
    try {
      await driversStore.deleteInstance(id);
      deleteConfirmId = null;
      toastStore.success($t('externalClis.deleted', { values: { id } }));
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : String(error));
    } finally {
      deletingId = null;
    }
  }
</script>

<SettingsPage title={$t('externalClis.title')} description={$t('externalClis.description')}>
  {#snippet actions()}
    <Button variant="outline" size="sm" disabled={driversStore.probingAll} onclick={() => void probeAll()}>
      {#if driversStore.probingAll}
        <LoaderCircle class="size-3.5 animate-spin" />
        {$t('externalClis.probing')}
      {:else}
        <RefreshCw class="size-3.5" />
        {$t('externalClis.probeAll')}
      {/if}
    </Button>
    <Button variant="default" size="sm" onclick={() => openNewDialog()}>
      <Plus class="size-3.5" />
      {$t('externalClis.addInstance')}
    </Button>
  {/snippet}

  {#if driversStore.error}
    <p role="alert" class="text-xs text-error">{driversStore.error}</p>
  {/if}

  <SettingsSection title={$t('externalClis.sectionTitle')} description={$t('externalClis.sectionHint')}>
    <SettingsRow label={$t('code.driverPicker.builtin')} description={$t('externalClis.builtinHint')} control="auto">
      {#snippet tile()}<DriverIcon instanceId="agente" driverKind="agente" size={16} />{/snippet}
      <Badge tone="neutral">{$t('code.driverPicker.builtinTag')}</Badge>
    </SettingsRow>

    {#each installedDrivers as driver (driver.instance_id)}
      <div class="cli-row-group">
        <SettingsRow
          label={driver.label}
          description={descriptionFor(driver)}
          error={rowErrorFor(driver)}
          align="start"
          control="auto"
        >
          {#snippet tile()}<DriverIcon instanceId={driver.instance_id} driverKind={driver.driver_kind} size={16} />{/snippet}
          <div class="flex flex-wrap items-center justify-end gap-1.5">
            <Badge tone={badgeTone(driver.status)}>{$t(`code.driverPicker.status.${driver.status}`)}</Badge>
            {#if driver.models?.length}
              <Button
                variant="ghost"
                size="xs"
                onclick={() => toggleModels(driver.instance_id)}
                aria-expanded={!!expandedModels[driver.instance_id]}
              >
                <ChevronDown class={`size-3 transition-transform duration-150${expandedModels[driver.instance_id] ? ' rotate-180' : ''}`} />
                {expandedModels[driver.instance_id]
                  ? $t('externalClis.modelsHide')
                  : $t('externalClis.modelsShow', { values: { n: driver.models.length } })}
              </Button>
            {/if}
            <Button
              variant="ghost"
              size="xs"
              disabled={!!driversStore.probingIds[driver.instance_id] || driversStore.probingAll}
              onclick={() => void probeOne(driver.instance_id)}
              title={$t('externalClis.probeOne')}
            >
              {#if driversStore.probingIds[driver.instance_id]}
                <LoaderCircle class="size-3 animate-spin" />
              {:else}
                <RefreshCw class="size-3" />
              {/if}
              {$t('externalClis.probeOne')}
            </Button>
            {#if driver.builtin}
              <Button variant="outline" size="xs" onclick={() => openNewDialog(driver.instance_id)}>
                <Copy class="size-3" />
                {$t('externalClis.addProfile')}
              </Button>
            {/if}
            <Button variant="ghost" size="xs" onclick={() => openEditDialog(driver)} title={$t('externalClis.edit')}>
              <Pencil class="size-3" />
            </Button>
            {#if !driver.builtin}
              {#if deleteConfirmId === driver.instance_id}
                <Button variant="destructive" size="xs" disabled={deletingId === driver.instance_id} onclick={() => void deleteInstance(driver.instance_id)}>
                  {$t('externalClis.confirmDelete')}
                </Button>
                <Button variant="ghost" size="xs" onclick={() => (deleteConfirmId = null)}>
                  {$t('code.worktree.cancel')}
                </Button>
              {:else}
                <Button variant="ghost" size="xs" onclick={() => (deleteConfirmId = driver.instance_id)} title={$t('externalClis.delete')}>
                  <Trash2 class="size-3" />
                </Button>
              {/if}
            {/if}
          </div>
        </SettingsRow>
        {#if expandedModels[driver.instance_id] && driver.models?.length}
          <ul class="pb-3 space-y-1">
            {#each driver.models as item (item.id)}
              <li class="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <span class="min-w-0 truncate text-foreground">
                  {item.label}
                  {#if item.id !== item.label}<span class="ml-1.5 font-mono text-muted-foreground">{item.id}</span>{/if}
                  {#if item.is_default}<span class="ml-1.5 text-[var(--brand-accent-strong)]">●</span>{/if}
                </span>
                {#if item.thinking_levels?.length}
                  <span class="shrink-0 font-mono text-[11px]">{item.thinking_levels.join(' / ')}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  </SettingsSection>

  {#if availableDrivers.length}
    <SettingsSection title={$t('externalClis.availableTitle')} description={$t('externalClis.availableHint')}>
      {#each availableDrivers as driver (driver.instance_id)}
        <SettingsRow
          label={driver.label}
          description={descriptionFor(driver)}
          align="start"
          control="auto"
        >
          {#snippet tile()}<DriverIcon instanceId={driver.instance_id} driverKind={driver.driver_kind} size={16} />{/snippet}
          <div class="flex flex-wrap items-center justify-end gap-1.5">
            <Badge tone="neutral">{$t(`code.driverPicker.status.${driver.status}`)}</Badge>
            <Button
              variant="ghost"
              size="xs"
              disabled={!!driversStore.probingIds[driver.instance_id] || driversStore.probingAll}
              onclick={() => void probeOne(driver.instance_id)}
              title={$t('externalClis.probeOne')}
            >
              {#if driversStore.probingIds[driver.instance_id]}
                <LoaderCircle class="size-3 animate-spin" />
              {:else}
                <RefreshCw class="size-3" />
              {/if}
              {$t('externalClis.probeOne')}
            </Button>
            <Button variant="ghost" size="xs" onclick={() => openEditDialog(driver)} title={$t('externalClis.edit')}>
              <Pencil class="size-3" />
            </Button>
          </div>
        </SettingsRow>
      {/each}
    </SettingsSection>
  {/if}

  <SettingsSection title={$t('externalClis.orchestratorTitle')} description={$t('externalClis.orchestratorHint')}>
    <SettingsRow
      label={$t('externalClis.orchestratorEndpoint')}
      description={orch?.enabled
        ? $t('externalClis.orchestratorStats', {
            values: {
              active: orch.active_tasks ?? 0,
              maxConcurrent: orch.max_concurrent ?? 0,
              maxDepth: orch.max_depth ?? 0
            }
          })
        : $t('externalClis.orchestratorInactiveHint')}
      control="auto"
    >
      <div class="flex items-center gap-1.5">
        <Badge tone={orch?.enabled ? 'success' : 'neutral'}>
          {orch?.enabled ? $t('externalClis.orchestratorActive') : $t('externalClis.orchestratorInactive')}
        </Badge>
        <Button variant="ghost" size="xs" disabled={refreshingOrch} onclick={() => void refreshOrchestrator()} title={$t('externalClis.orchestratorRefresh')}>
          {#if refreshingOrch}<LoaderCircle class="size-3 animate-spin" />{:else}<RefreshCw class="size-3" />{/if}
          {$t('externalClis.orchestratorRefresh')}
        </Button>
      </div>
    </SettingsRow>
    {#if tasks.length}
      <SettingsRow
        label={$t('externalClis.orchestratorTasksTitle')}
        description={tasks.slice(0, 6).map((item) => `${driverBadgeLabel(item.instance_id) || item.instance_id}: ${item.summary || item.error || item.status}`).join(' · ')}
        align="start"
        control="auto"
      >
        <Badge tone="neutral">{tasks.length}</Badge>
      </SettingsRow>
    {/if}
  </SettingsSection>
</SettingsPage>

{#if modalOpen}
  <Dialog
    title={editingExisting ? $t('externalClis.dialog.editTitle', { values: { id: formId } }) : $t('externalClis.dialog.addTitle')}
    description={$t('externalClis.dialog.description')}
    size="md"
    onclose={() => (modalOpen = false)}
  >
    <form
      id="external-cli-form"
      class="space-y-3 px-5 py-4"
      onsubmit={(e) => { e.preventDefault(); void saveForm(); }}
    >
      {#if !editingExisting}
        <div class="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={formMode === 'extends' ? 'default' : 'outline'}
            onclick={() => (formMode = 'extends')}
          >
            {$t('externalClis.dialog.modeProfile')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={formMode === 'acp' ? 'default' : 'outline'}
            onclick={() => (formMode = 'acp')}
          >
            {$t('externalClis.dialog.modeAcp')}
          </Button>
        </div>
      {/if}

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="block space-y-1">
          <span class="text-xs font-medium text-muted-foreground">{$t('externalClis.dialog.instanceId')}</span>
          <Input bind:value={formId} disabled={editingExisting} placeholder="claude-work" autocomplete="off" spellcheck="false" />
        </label>
        <label class="block space-y-1">
          <span class="text-xs font-medium text-muted-foreground">{$t('externalClis.dialog.label')}</span>
          <Input bind:value={formLabel} placeholder="Claude Code (Work)" autocomplete="off" />
        </label>
      </div>

      {#if formMode === 'extends' && (!editingExisting || !editingDriver?.builtin)}
        <div class="block space-y-1">
          <span class="text-xs font-medium text-muted-foreground">{$t('externalClis.dialog.baseCli')}</span>
          <Select bind:value={formBaseId} options={baseCliOptions} />
        </div>
      {/if}

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="block space-y-1">
          <span class="text-xs font-medium text-muted-foreground">
            {$t('externalClis.dialog.command')}
            {#if formMode === 'extends'}<span class="font-normal opacity-70">· {$t('providers.optional')}</span>{/if}
          </span>
          <Input bind:value={formCommand} placeholder={formMode === 'acp' ? 'my-agent --acp' : $t('externalClis.dialog.inheritCommand')} autocomplete="off" spellcheck="false" />
        </label>
        <label class="block space-y-1">
          <span class="text-xs font-medium text-muted-foreground">{$t('externalClis.dialog.args')}</span>
          <Input bind:value={formArgs} placeholder="--verbose" autocomplete="off" spellcheck="false" />
        </label>
      </div>

      <label class="block space-y-1">
        <span class="text-xs font-medium text-muted-foreground">{$t('externalClis.dialog.env')}</span>
        <Textarea bind:value={formEnv} rows={3} placeholder="CLAUDE_CONFIG_DIR=~/.claude-work" spellcheck="false" />
      </label>

      <label class="block space-y-1">
        <span class="text-xs font-medium text-muted-foreground">{$t('externalClis.dialog.stripEnv')}</span>
        <Input bind:value={formStripEnv} placeholder="ANTHROPIC_API_KEY, OPENAI_API_KEY" autocomplete="off" spellcheck="false" />
      </label>

      <label class="block space-y-1">
        <span class="text-xs font-medium text-muted-foreground">{$t('externalClis.dialog.useFor')}</span>
        <Input bind:value={formUseFor} placeholder={$t('externalClis.dialog.useForPlaceholder')} autocomplete="off" />
      </label>

      <div class="flex items-center justify-between pt-1">
        <span class="text-xs font-medium text-muted-foreground">{$t('externalClis.dialog.enabled')}</span>
        <Switch label={$t('externalClis.dialog.enabled')} bind:checked={formEnabled} />
      </div>

      {#if formError}
        <p role="alert" class="text-xs text-error">{formError}</p>
      {/if}
    </form>

    {#snippet footer()}
      <DialogActions
        cancelLabel={$t('code.worktree.cancel')}
        confirmLabel={$t('externalClis.dialog.save')}
        oncancel={() => (modalOpen = false)}
        disabled={!formId.trim()}
        busy={saving}
        confirmType="submit"
        form="external-cli-form"
      />
    {/snippet}
  </Dialog>
{/if}
