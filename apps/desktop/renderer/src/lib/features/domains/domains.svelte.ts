import type { CreativeProject, DomainStatus, MediaJob, MediaAssetRef } from '$shared/domains';
import { invoke, listen, isElectron } from '$lib/services/bridge';
class DomainsStore {
  packs = $state<DomainStatus[]>([]);
  projects = $state<CreativeProject[]>([]);
  jobs = $state<MediaJob[]>([]);
  project = $state<CreativeProject | null>(null);
  open = $state(false);
  error = $state('');
  loading = $state(false);
  private subscribed = false;
  async load() {
    if (!isElectron()) return;
    this.loading = true;
    try {
      const [packs, projects, jobs] = await Promise.all([invoke<DomainStatus[]>('domains_status'), invoke<CreativeProject[]>('domains_projects'), invoke<MediaJob[]>('domains_jobs')]);
      this.packs = packs ?? []; this.projects = projects ?? []; this.jobs = jobs ?? [];
      if (!this.subscribed) {
        this.subscribed = true;
        await listen<MediaJob>('domain_job', job => { const index = this.jobs.findIndex(v => v.id === job.id); if (index < 0) this.jobs = [...this.jobs, job].slice(-200); else this.jobs[index] = job; if (job.state === 'completed') void this.refreshProjects(); });
      }
    } catch (error) { this.error = (error as Error).message; } finally { this.loading = false; }
  }
  async refreshProjects() { this.projects = await invoke<CreativeProject[]>('domains_projects'); if (this.project) this.project = this.projects.find(p => p.id === this.project!.id) ?? this.project; }
  async enable(domain: string, enabled: boolean) { this.packs = await invoke<DomainStatus[]>('domains_set_enabled', { domain, enabled }); }
  async pickRuntime(dependency: string) { await invoke('domains_pick_runtime', { dependency }); await this.load(); }
  async call<T = unknown>(domain: string, operation: string, args: Record<string, unknown>, policy: 'read' | 'write' = 'read'): Promise<T> {
    this.error = '';
    try { return await invoke<T>('domains_call', { name: `domain_${policy}`, args: { domain, operation, args } }); }
    catch (error) { this.error = (error as Error).message; throw error; }
  }
  async create(domain: string, title: string) { this.project = await this.call<CreativeProject>(domain, 'create_project', { title }, 'write'); await this.refreshProjects(); this.open = true; }
  async select(project: CreativeProject) { this.project = await invoke<CreativeProject>('domains_project', { projectId: project.id }); this.open = true; }
  async patch(changes: Partial<CreativeProject>, label: string) { if (!this.project) return; this.project = await this.call<CreativeProject>(this.project.domain, 'patch', { projectId: this.project.id, expectedRevision: this.project.revision, label, changes }, 'write'); await this.refreshProjects(); }
  async history(direction: 'undo' | 'redo') { if (!this.project) return; this.project = await this.call<CreativeProject>(this.project.domain, direction, { projectId: this.project.id, expectedRevision: this.project.revision }, 'write'); }
  async importFile(file: File) {
    if (!this.project) return;
    const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') || /\.svg$/i.test(file.name) ? 'image' : /\.(blend|glb|gltf)$/i.test(file.name) ? 'scene' : 'audio';
    const asset = await invoke<MediaAssetRef>('domains_import', { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), kind });
    await this.patch({ assets: [...this.project.assets, asset] }, `Import ${file.name}`); return asset;
  }
  async url(asset: MediaAssetRef): Promise<string> {
    if (asset.kind === 'audio' || asset.kind === 'video') return `agente-media://asset/${encodeURIComponent(asset.id)}`;
    const preview = await invoke<{ bytes: Uint8Array; mime: string }>('domains_preview', { assetId: asset.id });
    return URL.createObjectURL(new Blob([new Uint8Array(preview.bytes)], { type: preview.mime }));
  }
  async cancel(job: MediaJob) { await invoke('domains_cancel', { jobId: job.id }); }
}
export const domainsStore = new DomainsStore();
