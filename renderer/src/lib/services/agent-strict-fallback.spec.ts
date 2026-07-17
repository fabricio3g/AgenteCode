import { describe, expect, it, vi } from 'vitest';
import { buildStrictFallbackContent } from '$lib/services/agent-strict-fallback';
import type { ToolContext, ToolObservation } from '$lib/services/agent-types';

describe('agent-strict-fallback', () => {
  it('lists files and missing file types without fallback boilerplate', async () => {
    const ensureRequestedArtifactsFromEvidence = vi.fn().mockResolvedValue(['brief.docx']);
    const ctx: ToolContext = {
      chatId: 'chat-1',
      files: {
        'brief.docx': 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,abc'
      },
      executionMode: 'sandbox',
      onArtifact: vi.fn()
    };
    const observations: ToolObservation[] = [
      { name: 'web_search', args: {}, success: true, summary: 'Found sources' }
    ];

    const content = await buildStrictFallbackContent({
      prompt: 'Create a docx and pdf brief',
      reason: 'the tool budget was reached',
      ctx,
      observations,
      sources: [{ title: 'Example', url: 'https://example.com', snippet: 'Snippet' }],
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: (_observations, sources) => sources,
      missingRequestedArtifactExtensions: () => ['pdf']
    });

    expect(ensureRequestedArtifactsFromEvidence).toHaveBeenCalledOnce();
    expect(content).toContain('brief.docx');
    expect(content).toContain('## Missing requested files');
    expect(content).toContain('.pdf');
    expect(content).not.toContain('Agent stopped because');
    expect(content).not.toContain('What was completed');
    expect(content).not.toContain('## Gathered Evidence');
  });

  it('renders a synthesized research report instead of a Gathered Evidence dump', async () => {
    const ensureRequestedArtifactsFromEvidence = vi.fn().mockResolvedValue([]);
    const ctx: ToolContext = {
      chatId: 'chat-1',
      files: {},
      executionMode: 'sandbox',
      onArtifact: vi.fn()
    };
    const observations: ToolObservation[] = [
      {
        name: 'web_search',
        args: {},
        success: true,
        summary: 'Distributed solar microgrids improve site resilience by pairing local generation with battery storage and controllable loads.'
      }
    ];

    const content = await buildStrictFallbackContent({
      prompt: 'Give me an extensive report on distributed solar microgrids',
      reason: 'the tool budget was reached',
      ctx,
      observations,
      sources: [
        {
          title: 'Microgrid resilience overview',
          url: 'https://example.com/microgrid-resilience',
          snippet: 'Distributed solar microgrids can keep critical loads online during wider grid outages when paired with storage and controls.'
        },
        {
          title: 'Battery storage economics',
          url: 'https://example.com/storage-economics',
          snippet: 'Battery storage can shift midday solar generation into evening demand periods and reduce peak-grid purchases.'
        }
      ],
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: (_observations, sources) => sources,
      missingRequestedArtifactExtensions: () => []
    });

    expect(ensureRequestedArtifactsFromEvidence).toHaveBeenCalledOnce();
    expect(ctx.files).toEqual({});
    expect(content).not.toContain('## Gathered Evidence');
    expect(content).not.toContain('## Executive summary');
    expect(content).toContain('## Key findings');
    expect(content).toContain('## References');
    expect(content).toContain('## Limitations');
    expect(content).toContain('Distributed solar microgrids improve site resilience');
    expect(content).toContain('Battery storage can shift midday solar generation');
    expect(content).toMatch(/\[2\]|# distributed solar microgrids/i);
    expect(content).toContain('https://example.com/storage-economics');
    expect(content).toContain('Partial research report');
    expect(content).not.toContain('Agent stopped because');
    expect(content).not.toContain('What was completed:');
  });

  it('uses medical section structure for general clinical research topics', async () => {
    const ensureRequestedArtifactsFromEvidence = vi.fn().mockResolvedValue([]);
    const ctx: ToolContext = {
      chatId: 'chat-1',
      files: {},
      executionMode: 'sandbox',
      onArtifact: vi.fn()
    };
    const observations: ToolObservation[] = [
      {
        name: 'web_search',
        args: {},
        success: true,
        summary: 'Clinical presentation varies by disease stage. Diagnosis typically combines history, examination, and confirmatory testing. Treatment often starts with first-line therapy and may add adjuvant management based on severity and comorbidities.'
      }
    ];

    const content = await buildStrictFallbackContent({
      prompt: 'Comprehensive overview of clinical presentation, diagnosis, management and treatment outcomes for this medical condition',
      reason: 'iteration limit',
      ctx,
      observations,
      sources: [
        {
          title: 'Clinical practice overview',
          url: 'https://example.com/clinical-overview',
          snippet: 'Guideline-aligned treatment pathways emphasize shared decision-making, monitoring for adverse effects, and staged escalation of therapy.'
        }
      ],
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: (_observations, sources) => sources,
      missingRequestedArtifactExtensions: () => []
    });

    expect(content).not.toContain('## Gathered Evidence');
    expect(content).not.toContain('## Executive summary');
    expect(content).toContain('## Definition and clinical importance');
    expect(content).toContain('## Treatment and management');
    expect(content).toContain('## References');
    expect(content).toMatch(/treatment|diagnos|clinical|therapy/i);
  });
});
