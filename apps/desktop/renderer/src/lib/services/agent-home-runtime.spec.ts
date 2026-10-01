import { describe, expect, it, vi } from 'vitest';
import { homeRuntimeBudget } from '$lib/stores/app-context-budget';
import type { HomeRuntimeMeta } from '$shared/home-runtime';

vi.mock('$lib/utils/storage', () => ({ loadAppConfig: vi.fn() }));
vi.mock('./agent-run-plan', () => ({ resolveAgentRunPlan: vi.fn() }));
vi.mock('./agent-run-context', () => ({ createAgentRun: vi.fn(), emitSteps: vi.fn(), injectLiveEvidence: vi.fn() }));
vi.mock('./agent-home-tools', () => ({ createHomeTools: vi.fn() }));
vi.mock('./agent-home-policy', () => ({ createHomeHooks: vi.fn(), createPolicyState: vi.fn(), startThinkStep: vi.fn() }));
vi.mock('./agent-research-bootstrap', () => ({ runResearchBootstrap: vi.fn() }));
import { canContinueHomeHistory } from './agent-home-runtime';

const meta: HomeRuntimeMeta = { sessionId: 'session', revision: 2, provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindow: 128_000, contextTokens: 64_000, historyIds: ['user-1', 'answer-1'] };
describe('Home runtime history and context', () => {
  it('continues incrementally and rebuilds edited or forked history', () => {
    expect(canContinueHomeHistory(meta, ['user-1', 'answer-1', 'user-2'])).toBe(true);
    expect(canContinueHomeHistory(meta, ['user-1', 'edited-answer', 'user-2'])).toBe(false);
    expect(canContinueHomeHistory(meta, ['user-1'])).toBe(false);
    expect(canContinueHomeHistory(undefined, ['user-1'])).toBe(false);
  });
  it('uses reported usage and marks draft or compacted usage as estimates', () => {
    expect(homeRuntimeBudget(meta)).toMatchObject({ maxContext: 128_000, usedTokens: 64_000, usagePercent: 50, estimated: false });
    expect(homeRuntimeBudget({ ...meta, contextTokens: 12_000, estimated: true })).toMatchObject({ usedTokens: 12_000, estimated: true });
    expect(homeRuntimeBudget(meta, 'new draft')).toMatchObject({ estimated: true });
  });
  it('rejects invalid readings and clamps overflow', () => {
    expect(homeRuntimeBudget({ ...meta, contextWindow: NaN })).toBeNull();
    expect(homeRuntimeBudget({ ...meta, contextTokens: Infinity })).toBeNull();
    expect(homeRuntimeBudget({ ...meta, contextTokens: 200_000 })).toMatchObject({ remaining: 0, usagePercent: 100, isOverflow: true });
  });
});
