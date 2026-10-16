import { parseTweaks } from '$lib/features/design/design-tweaks';
import { describe, expect, it } from 'vitest';
import { DESIGN_SYSTEM_PROMPT, attachedReferencesBlock, designWorkspaceBriefing, matchReferencesBlock, referenceLines } from './design-prompts';

describe('design briefing', () => {
  it('lists the references first and leaves the section out when there are none', () => {
    const listing = ['index.html (120 bytes)', 'references/stripe-com-1.png (48213 bytes)', 'tokens.css (300 bytes)'].join('\n');
    expect(referenceLines(listing)).toEqual(['- references/stripe-com-1.png (48213 bytes)']);
    expect(designWorkspaceBriefing(listing, '', ':root{}')).toContain('### References (look at these first with design_view)\n\n- references/stripe-com-1.png (48213 bytes)');
    expect(designWorkspaceBriefing('index.html (1 bytes)', '', '')).not.toContain('References');
  });
});

describe('attachedReferencesBlock', () => {
  it('is empty when nothing was attached', () => {
    expect(attachedReferencesBlock([])).toBe('');
  });

  it('names each image saved from the message', () => {
    const block = attachedReferencesBlock(['references/hero.png', 'references/menu-2.jpg']);
    expect(block).toContain('## Attached to this message');
    expect(block).toContain('- references/hero.png');
    expect(block).toContain('- references/menu-2.jpg');
  });
});

describe('system prompt', () => {
  it('teaches the agent to look before it borrows, and never to copy', () => {
    expect(DESIGN_SYSTEM_PROMPT).toContain('## Research');
    expect(DESIGN_SYSTEM_PROMPT).toContain('design_reference');
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/never copy a logo/i);
  });

  it('teaches tweaks.json, and its example parses as tweaks', () => {
    expect(DESIGN_SYSTEM_PROMPT).toContain('## Tweaks');
    const example = /\n(\[\{"id":"radius".*\}\])\n/.exec(DESIGN_SYSTEM_PROMPT)?.[1] ?? '';
    expect(parseTweaks(example).map((tweak) => tweak.type)).toEqual(['range', 'color', 'choice']);
    expect(DESIGN_SYSTEM_PROMPT).toContain('Marks drawn on the canvas');
  });
});

describe('matchReferencesBlock', () => {
  it('is empty with no references, or when every one was just attached', () => {
    expect(matchReferencesBlock([])).toBe('');
    expect(matchReferencesBlock(['references/a.png'], ['references/a.png'])).toBe('');
  });

  it('names the collected references the message did not attach', () => {
    const block = matchReferencesBlock(['references/a.png', 'references/b.png'], ['references/a.png']);
    expect(block).toContain('## Match the references');
    expect(block).toContain('- references/b.png');
    expect(block).not.toContain('- references/a.png');
  });
});

describe('flows in the system prompt', () => {
  it('teaches flows.json with a parseable example', () => {
    expect(DESIGN_SYSTEM_PROMPT).toContain('## Flows');
    const example = /(\{"links":\[.*?\]\})/.exec(DESIGN_SYSTEM_PROMPT)?.[1] ?? '';
    expect(JSON.parse(example).links[0]).toEqual({ from: 'index.html', to: 'pricing.html' });
  });
});
