import { describe, expect, it } from 'vitest';
import { asksUserForDetails } from './agent-clarify';

const question = "I'll create a PDF for you. To make it useful, could you tell me: 1. What should the title be? 2. What content should it contain?";

describe('asksUserForDetails', () => {
  it('lets a clarifying question stand when nothing was gathered', () => {
    expect(asksUserForDetails(question, [])).toBe(true);
    expect(asksUserForDetails(question, [{ name: 'web_search', args: {}, success: false, summary: 'failed' }])).toBe(true);
  });

  it('still builds files once there is evidence, or when the reply is content', () => {
    expect(asksUserForDetails(question, [{ name: 'web_search', args: {}, success: true, summary: '5 results' }])).toBe(false);
    expect(asksUserForDetails('Here is the full report on the market.', [])).toBe(false);
    expect(asksUserForDetails(`${'Long report. '.repeat(200)}Any questions?`, [])).toBe(false);
  });
});
