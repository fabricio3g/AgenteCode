import { describe, expect, it } from 'vitest';
import {
  buildResearchEvidencePack,
  extractRelevantExcerpt,
  injectResearchEvidencePack
} from '$lib/services/agent-evidence-pack';
import type { ToolObservation } from '$lib/services/agent-types';
import type { SearchResult } from '$lib/types/bridge';

describe('agent-evidence-pack', () => {
  it('extracts query-relevant paragraphs from long page text', () => {
    const content = [
      'Introduction about weather and agriculture across regions.',
      '',
      'Clinical diagnosis often combines history, physical examination, and confirmatory laboratory testing.',
      '',
      'Unrelated paragraph about renewable energy storage systems and grid tariffs.',
      '',
      'Treatment pathways typically escalate from first-line therapy to adjunctive management when response is incomplete.'
    ].join('\n');

    const excerpt = extractRelevantExcerpt(content, 'clinical diagnosis treatment therapy pathways', 400);
    expect(excerpt.toLowerCase()).toContain('clinical diagnosis');
    expect(excerpt.toLowerCase()).toContain('treatment pathways');
    expect(excerpt.toLowerCase()).not.toContain('renewable energy');
  });

  it('builds a compact pack with numbered sources and synthesis instructions', () => {
    const observations: ToolObservation[] = [
      {
        name: 'web_search',
        args: { query: 'clinical treatment guidelines' },
        success: true,
        summary: 'Found clinical reviews describing diagnosis workflows and staged treatment options.'
      }
    ];
    const sources: SearchResult[] = [
      {
        title: 'Clinical practice review',
        url: 'https://example.com/clinical-review',
        snippet: 'Short snippet',
        full_content: 'Diagnosis often uses validated criteria and confirmatory tests. First-line therapy is selected by severity, comorbidities, and guideline recommendations.'
      },
      {
        title: 'Blocked page',
        url: 'https://example.com/blocked',
        snippet: 'Access denied',
        metadata: { quality: 'blocked' }
      }
    ];

    const pack = buildResearchEvidencePack(observations, sources, {
      query: 'clinical diagnosis and treatment overview',
      mode: 'deep'
    });

    expect(pack).toContain('=== RESEARCH EVIDENCE PACK ===');
    expect(pack).toContain('[1]');
    expect(pack).toContain('https://example.com/clinical-review');
    expect(pack).toContain('Excerpt:');
    expect(pack).toMatch(/diagnos|therapy|treatment|clinical/i);
    expect(pack).toContain('Do NOT paste this pack');
    expect(pack).toContain('Gathered Evidence');
    expect(pack).toContain('=== END EVIDENCE PACK ===');
  });

  it('injectResearchEvidencePack replaces prior packs and legacy evidence summaries', () => {
    const messages = [
      { role: 'system' as const, content: 'base system' },
      { role: 'system' as const, content: '=== EVIDENCE SUMMARY ===\nold' },
      { role: 'user' as const, content: 'research this' }
    ];
    const observations: ToolObservation[] = [
      { name: 'fetch_url', args: {}, success: true, summary: 'Page describes first-line therapy options and monitoring for adverse effects.' }
    ];
    const sources: SearchResult[] = [
      {
        title: 'Guideline',
        url: 'https://example.com/guideline',
        snippet: 'Current guidelines recommend staged management with clear criteria for escalation of care.'
      }
    ];

    injectResearchEvidencePack(messages, observations, sources, {
      query: 'clinical management guidelines',
      mode: 'max'
    });

    const packs = messages.filter((m) => typeof m.content === 'string' && m.content.startsWith('=== RESEARCH EVIDENCE PACK ==='));
    expect(packs).toHaveLength(1);
    expect(messages.some((m) => m.content?.startsWith('=== EVIDENCE SUMMARY ==='))).toBe(false);
    expect(packs[0].content).toContain('Mode: max');
    expect(packs[0].content).toMatch(/guideline|therapy|management|first-line/i);
  });
});
