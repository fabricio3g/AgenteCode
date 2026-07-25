import { describe, expect, it, vi } from 'vitest';
import {
  buildStrictFallbackContent,
  renderLiveDataFallback,
  synthesizeProse
} from '$lib/services/agent-strict-fallback';
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
      mode: 'research',
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: (_observations, sources) => sources,
      missingRequestedArtifactExtensions: () => []
    });

    expect(ensureRequestedArtifactsFromEvidence).toHaveBeenCalledOnce();
    expect(ctx.files).toEqual({});
    expect(content).not.toContain('## Gathered Evidence');
    expect(content).not.toContain('## Executive summary');
    expect(content).toContain('## Limitations');
    expect(content).toContain('## References');
    expect(content).toContain('Distributed solar microgrids');
    expect(content).toContain('Battery storage can shift midday solar generation');
    expect(content).toMatch(/\[1\]|\[2\]|# distributed solar microgrids/i);
    expect(content).toContain('https://example.com/storage-economics');
    expect(content).toMatch(/Partial answer from sources already retrieved/i);
    expect(content).not.toContain('Agent stopped because');
    expect(content).not.toContain('What was completed:');
    // Prefer prose over rigid bullet dump of raw snippets
    expect(content).not.toMatch(/^-\s+Distributed solar microgrids can keep/m);
  });

  it('uses medical section structure only when section evidence exists', async () => {
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
        summary: 'Clinical presentation varies by disease stage. Diagnosis typically combines history, examination, and confirmatory testing. Treatment often starts with first-line therapy and may add adjuvant management based on severity and comorbidities. Prognosis improves with early remission monitoring and follow-up.'
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
      mode: 'research',
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: (_observations, sources) => sources,
      missingRequestedArtifactExtensions: () => []
    });

    expect(content).not.toContain('## Gathered Evidence');
    expect(content).not.toContain('## Executive summary');
    expect(content).not.toContain('_Not enough specific evidence was retrieved for this section._');
    expect(content).toContain('## References');
    expect(content).toMatch(/treatment|diagnos|clinical|therapy/i);
  });

  it('chat mode returns plain prose without research report headings', async () => {
    const ensureRequestedArtifactsFromEvidence = vi.fn().mockResolvedValue([]);
    const ctx: ToolContext = {
      chatId: 'chat-1',
      files: {},
      executionMode: 'sandbox',
      onArtifact: vi.fn()
    };

    const content = await buildStrictFallbackContent({
      prompt: 'What did the sources say about battery storage?',
      reason: 'iteration limit',
      ctx,
      observations: [],
      sources: [
        {
          title: 'Storage note',
          url: 'https://example.com/storage',
          snippet: 'Battery storage can shift midday solar generation into evening demand periods and reduce peak-grid purchases for commercial sites.'
        }
      ],
      mode: 'chat',
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: (_observations, sources) => sources,
      missingRequestedArtifactExtensions: () => []
    });

    expect(content).toContain('Battery storage can shift midday solar generation');
    expect(content).toMatch(/could not complete every step|based only on what was already found/i);
    expect(content).not.toContain('## Key findings');
    expect(content).not.toContain('## Limitations');
    expect(content).not.toContain('## Gathered Evidence');
    expect(content).not.toContain('Agent stopped because');
  });

  it('chat mode empty evidence is a short honest message', async () => {
    const ensureRequestedArtifactsFromEvidence = vi.fn().mockResolvedValue([]);
    const ctx: ToolContext = {
      chatId: 'chat-1',
      files: {},
      executionMode: 'sandbox',
      onArtifact: vi.fn()
    };

    const content = await buildStrictFallbackContent({
      prompt: 'hello?',
      reason: 'iteration limit',
      ctx,
      observations: [],
      sources: [],
      mode: 'chat',
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: () => [],
      missingRequestedArtifactExtensions: () => []
    });

    expect(content).toMatch(/did not gather enough information|try again|rephrase/i);
    expect(content).not.toContain('## Key findings');
    expect(content).not.toContain('Gathered Evidence');
  });

  it('live weather observation becomes a plain answer in chat mode', async () => {
    const ensureRequestedArtifactsFromEvidence = vi.fn().mockResolvedValue([]);
    const ctx: ToolContext = {
      chatId: 'chat-1',
      files: {
        'weather-card.json': JSON.stringify({
          title: 'Paris',
          rows: [
            { label: 'Temperature', value: '18°C' },
            { label: 'Conditions', value: 'Partly cloudy' }
          ]
        })
      },
      executionMode: 'sandbox',
      onArtifact: vi.fn()
    };

    const content = await buildStrictFallbackContent({
      prompt: 'weather in Paris',
      reason: 'iteration limit',
      ctx,
      observations: [
        {
          name: 'get_weather',
          args: { location: 'Paris' },
          success: true,
          summary: 'Temperature 18°C\nConditions: Partly cloudy'
        }
      ],
      sources: [],
      mode: 'chat',
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: () => [],
      missingRequestedArtifactExtensions: () => []
    });

    expect(content).toMatch(/18°C|Partly cloudy|Temperature/i);
    expect(content).not.toContain('## Key findings');
    expect(content).not.toContain('## Limitations');
    expect(content).not.toContain('Gathered Evidence');
  });

  it('renderLiveDataFallback reads info-card rows', () => {
    const text = renderLiveDataFallback({
      prompt: 'weather in Paris',
      observations: [],
      files: {
        'weather-card.json': JSON.stringify({
          rows: [
            { label: 'Temperature', value: '18°C' },
            { label: 'Conditions', value: 'Clear' }
          ]
        })
      }
    });
    expect(text).toBeTruthy();
    expect(text).toContain('18°C');
    expect(text).toContain('Clear');
  });

  it('synthesizeProse joins items into sentences with citations', () => {
    const prose = synthesizeProse(
      [
        { text: 'first finding about resilience and local generation capacity', sourceId: '1' },
        { text: 'second finding about battery storage economics and peak demand', sourceId: '2' }
      ],
      { withCitations: true }
    );
    expect(prose).toMatch(/First finding/i);
    expect(prose).toContain('[1]');
    expect(prose).toContain('[2]');
    expect(prose).not.toMatch(/^- /m);
  });
});
