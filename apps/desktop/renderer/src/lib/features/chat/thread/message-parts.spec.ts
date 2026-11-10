import { describe, expect, it } from 'vitest';
import type { ChatMessage, MessageVersion } from '$lib/types/chat';
import {
  buildMessageParts,
  hasSearchStatus,
  isAssistantMessageEmpty,
  type MessagePartKind
} from './message-parts';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: 0,
    ...overrides
  };
}

function build(
  overrides: Partial<Parameters<typeof buildMessageParts>[0]> = {}
): MessagePartKind[] {
  return buildMessageParts({
    message: message(),
    displayContent: '',
    displayReasoning: '',
    displayMetadata: null,
    enableThinking: true,
    hasActiveDeepResearch: false,
    hasDocumentArtifact: false,
    hasPendingApproval: false,
    ...overrides
  }).map((part) => part.kind);
}

describe('buildMessageParts', () => {
  it.each(['home', 'design'] as const)('shows the shared work block and bottom live status in %s', (contextMode) => {
    expect(build({ contextMode, hasLiveRun: true, message: message({ status: 'streaming' }) })).toEqual(['live-status']);
    expect(build({
      contextMode, hasLiveRun: true, hasPendingApproval: true,
      message: message({ status: 'streaming', searchMode: 'search' }),
      displayReasoning: 'Reasoning in progress',
      displayContent: 'An answer'
    })).toEqual(['tool-status', 'approval', 'research', 'content', 'live-status']);
    expect(build({
      contextMode, hasLiveRun: true,
      message: message({ status: 'idle' }), displayReasoning: 'Finished thinking'
    })).toEqual(['tool-status']);
  });

  it('shows search, deep and max runs as the research widget, not the step line', () => {
    for (const searchMode of ['search', 'deep', 'max'] as const) {
      const kinds = build({
        message: message({ searchMode, status: 'streaming', mode: 'agent', agentSteps: [{ id: 's1', type: 'searching', label: 'Search', status: 'running', toolName: 'web_search' }] }),
        displayContent: 'Answer so far'
      });
      expect(kinds[0]).toBe('research');
      expect(kinds).not.toContain('tool-status');
      expect(kinds).toContain('content');
    }
    expect(build({ message: message({ searchMode: 'chat', mode: 'agent', agentSteps: [{ id: 's1', type: 'tool', label: 'x', status: 'done' }] }) })).toContain('tool-status');
  });

  it('puts a pending approval directly after the tool status line', () => {
    const kinds = build({
      message: message({ status: 'streaming', agentSteps: [{ id: 's1', type: 'tool', label: 'bash', status: 'running' }] }),
      hasPendingApproval: true
    });
    expect(kinds.indexOf('approval')).toBe(kinds.indexOf('tool-status') + 1);
  });

  it('shows Design tool work even when the composer selected Instant', () => {
    expect(build({contextMode:'design',message:message({mode:'instant',agentSteps:[{id:'d1',type:'tool',label:'Blender',toolName:'design_3d',status:'running'}]})})).toContain('tool-status');
  });

  it('suppresses the typing dots while an approval is waiting', () => {
    // Dots next to an unanswered question would imply the agent was still
    // working, when in fact it is blocked on the user.
    const kinds = build({
      message: message({ status: 'streaming' }),
      hasPendingApproval: true
    });
    expect(kinds).toContain('approval');
    expect(kinds).not.toContain('pending');
  });

  it('omits the approval part when nothing is awaiting one', () => {
    const kinds = build({
      message: message({ status: 'streaming', agentSteps: [{ id: 's1', type: 'tool', label: 'bash', status: 'running' }] })
    });
    expect(kinds).not.toContain('approval');
  });

  it('shows only typing dots while streaming with nothing to render yet', () => {
    expect(build({ message: message({ status: 'streaming' }) })).toEqual(['pending']);
  });

  it('drops the typing dots as soon as any content arrives', () => {
    const kinds = build({
      message: message({ status: 'streaming' }),
      displayContent: 'Partial answ'
    });
    expect(kinds).toEqual(['content']);
  });

  it('drops the typing dots when reasoning is streaming ahead of content', () => {
    const kinds = build({
      message: message({ status: 'streaming' }),
      displayReasoning: 'Let me consider'
    });
    expect(kinds).toEqual(['reasoning']);
    expect(kinds).not.toContain('pending');
  });

  it('falls back to typing dots when reasoning is suppressed by the setting', () => {
    const kinds = build({
      message: message({ status: 'streaming' }),
      displayReasoning: 'hidden',
      enableThinking: false
    });
    // Previously this rendered a completely blank message: the dots were
    // suppressed by the presence of reasoning the user had chosen not to see.
    expect(kinds).toEqual(['pending']);
  });

  it('renders an error instead of content, never both', () => {
    const kinds = build({
      message: message({ status: 'error' }),
      displayContent: 'Half an answer',
      displayMetadata: { error: true, errorMessage: 'rate limited' }
    });
    expect(kinds).toContain('error');
    expect(kinds.filter((k) => k === 'error')).toHaveLength(1);
  });

  it('shows a stop warning only when there is no content to speak for itself', () => {
    const stopped: MessageVersion['metadata'] = { warning: 'Stopped early', outcome: 'stopped' };
    expect(build({ displayMetadata: stopped })).toContain('warning');
    expect(build({ displayContent: 'Answer', displayMetadata: stopped })).not.toContain('warning');
  });

  it('emits one status line for a tool run, not one per step', () => {
    const kinds = build({
      message: message({
        agentSteps: [
          { id: 's1', type: 'searching', label: 'Search', status: 'done' },
          { id: 's2', type: 'reading', label: 'Read', status: 'done' },
          { id: 's3', type: 'writing', label: 'Write', status: 'done' }
        ]
      }),
      displayContent: 'Done'
    });
    expect(kinds.filter((k) => k === 'tool-status')).toHaveLength(1);
  });

  it('shows typing dots, not a planning row, before an agent turn has said anything', () => {
    const kinds = build({
      message: message({ mode: 'agent', status: 'streaming' })
    });
    expect(kinds).toContain('pending');
    expect(kinds).not.toContain('tool-status');
  });

  it('leads an agent turn with its opening line, above the work', () => {
    const kinds = build({
      message: message({
        mode: 'agent',
        status: 'streaming',
        agentSteps: [
          { id: 'p', type: 'done', label: 'Preface', status: 'done', preface: true, detail: "I'll check the weather." },
          { id: 's', type: 'thinking', label: 'Planning', status: 'running' }
        ]
      }),
      displayContent: "I'll check the weather."
    });
    expect(kinds).toEqual(['preface', 'tool-status']);
  });

  it('renders a report surface for report metadata', () => {
    const kinds = build({
      displayContent: '# Kelp forests\n\nBody.',
      displayMetadata: { documentSurface: { kind: 'report', title: 'Kelp forests' } }
    });
    expect(kinds).toEqual(['content', 'document']);
  });

  it('does not render a second document when the artifact is already one', () => {
    const kinds = build({
      displayContent: '# Kelp forests',
      displayMetadata: { documentSurface: { kind: 'report' } },
      hasDocumentArtifact: true,
      message: message({ artifact: {} as never })
    });
    expect(kinds).not.toContain('document');
    expect(kinds.filter((k) => k === 'artifact')).toHaveLength(1);
  });

  it('titles a report from the first heading when metadata omits one', () => {
    const parts = buildMessageParts({
      message: message(),
      displayContent: '## Tidal patterns\n\nBody.',
      displayReasoning: '',
      displayMetadata: { documentSurface: { kind: 'report' } },
      enableThinking: true,
      hasActiveDeepResearch: false,
      hasDocumentArtifact: false,
      hasPendingApproval: false
    });
    const doc = parts.find((part) => part.kind === 'document');
    expect(doc).toMatchObject({ title: 'Tidal patterns' });
    expect(doc && 'docs' in doc && doc.docs[0].name).toBe('tidal-patterns.md');
  });

  it('lets a live deep-research task lead, and keeps the dots away', () => {
    const kinds = build({
      message: message({ status: 'streaming' }),
      hasActiveDeepResearch: true
    });
    expect(kinds).toEqual(['deep-research']);
  });

  it('keeps parts in a stable order', () => {
    const kinds = build({
      message: message({
        mode: 'agent',
        agentSteps: [{ id: 's1', type: 'tool', label: 'Tool', status: 'done' }],
        slides: [{} as never],
        filesCreated: [{} as never],
        artifact: {} as never
      }),
      displayContent: 'Answer',
      displayReasoning: 'Because',
      displayMetadata: { documentSurface: { kind: 'report', title: 'Report' } }
    });
    expect(kinds).toEqual([
      'tool-status',
      'content',
      'document',
      'slides',
      'files-created',
      'artifact'
    ]);
  });

  it('hushes instant runs: no reasoning trace, no tool-status line', () => {
    const kinds = build({
      message: message({
        mode: 'instant',
        status: 'streaming',
        agentSteps: [{ id: 's1', type: 'tool', label: 'web_search', status: 'running' }]
      }),
      displayContent: 'Answer',
      displayReasoning: 'Because',
      displayMetadata: {}
    });
    expect(kinds).toEqual(['content']);
  });

  it('carries the quiet status on the instant typing indicator', () => {
    const parts = buildMessageParts({
      message: message({ mode: 'instant', status: 'streaming' }),
      displayContent: '',
      displayReasoning: '',
      displayMetadata: { activityLabel: 'Searching' },
      enableThinking: true,
      hasActiveDeepResearch: false,
      hasDocumentArtifact: false,
      hasPendingApproval: false
    });
    expect(parts).toEqual([{ kind: 'pending', status: 'Searching' }]);
  });

  it('leaves plain pending dots status-free outside instant mode', () => {
    const parts = buildMessageParts({
      message: message({ mode: 'chat', status: 'streaming' }),
      displayContent: '',
      displayReasoning: '',
      displayMetadata: { activityLabel: 'Planning' },
      enableThinking: true,
      hasActiveDeepResearch: false,
      hasDocumentArtifact: false,
      hasPendingApproval: false
    });
    expect(parts).toEqual([{ kind: 'pending' }]);
  });
});

describe('isAssistantMessageEmpty', () => {
  const base = {
    message: message(),
    displayContent: '',
    displayReasoning: '',
    displayMetadata: null,
    hasActiveDeepResearch: false
  };

  it('treats a finished assistant turn with no output as empty', () => {
    expect(isAssistantMessageEmpty(base)).toBe(true);
  });

  it.each([
    ['content', { displayContent: 'hi' }],
    ['reasoning', { displayReasoning: 'hmm' }],
    ['sources', { message: message({ sources: [{} as never] }) }],
    ['an artifact', { message: message({ artifact: {} as never }) }],
    ['an artifact collection', { message: message({ artifacts: [{} as never] }) }],
    ['a warning', { displayMetadata: { warning: 'partial' } }],
    ['streaming status', { message: message({ status: 'streaming' as const }) }]
  ])('is not empty when it has %s', (_label, overrides) => {
    expect(isAssistantMessageEmpty({ ...base, ...overrides })).toBe(false);
  });

  it('never treats a user message as empty', () => {
    expect(isAssistantMessageEmpty({ ...base, message: message({ role: 'user' }) })).toBe(false);
  });
});

describe('hasSearchStatus', () => {
  it('is quiet when the search worked and produced sources', () => {
    expect(
      hasSearchStatus(
        { searchRequested: true, searchSucceeded: true, contextAvailable: true, sourceCount: 4 },
        true
      )
    ).toBe(false);
  });

  it('speaks up when a search was requested but returned nothing', () => {
    expect(
      hasSearchStatus(
        { searchRequested: true, searchSucceeded: false, contextAvailable: false, sourceCount: 0 },
        false
      )
    ).toBe(true);
  });

  it('speaks up on provider warnings even with sources present', () => {
    expect(
      hasSearchStatus(
        {
          searchRequested: true,
          searchSucceeded: true,
          contextAvailable: true,
          sourceCount: 2,
          providerWarnings: ['brave rate limited']
        },
        true
      )
    ).toBe(true);
  });

  it('has nothing to say without metadata', () => {
    expect(hasSearchStatus(null, false)).toBe(false);
  });
});
