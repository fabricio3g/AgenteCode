/**
 * Research product runs (Search / Deep / Max) start from a system-owned
 * search, the way research products do it — search, read, write — instead of
 * waiting for the model to decide to look something up.
 */

import type { AgentStep } from '$lib/types/chat';
import { say } from '$lib/copy';
import { webSearch } from '$lib/services/search';
import { compactText } from '$lib/services/agent-evidence';
import { toErrorMessage, isAbortError } from '$lib/utils/errors';
import { hasEnoughResearchEvidence, researchEvidenceThreshold } from '$lib/services/research-pipeline';
import { debugLog, uid } from '$lib/services/agent-tool-dispatch';
import { emitSteps, injectLiveEvidence, prompt, type AgentRun } from '$lib/services/agent-run-context';

/** Run the first search; true when it gathered sources the model can write from. */
export async function runResearchBootstrap(run: AgentRun): Promise<boolean> {
  const query = prompt(run);
  if (!run.plan.isResearchChat || !query.trim()) return false;
  const { args, plan, sources, seenUrls } = run;
  const mode = plan.researchMode;

  const step: AgentStep = { id: uid('step'), type: 'searching', label: 'Searching', status: 'running', detail: query.slice(0, 160) };
  run.steps.push(step);
  emitSteps(run);
  args.onProgress?.('Searching…');

  let gathered = false;
  try {
    const response = await webSearch({
      query,
      context: args.conversationContext,
      deep: mode !== 'search',
      mode,
      options: { max_results: researchEvidenceThreshold(mode).resultBudget }
    });
    if (!response.error && Array.isArray(response.results) && response.results.length) {
      for (const entry of response.results) {
        if (!entry?.url) continue;
        if (seenUrls.has(entry.url)) {
          // Keep whichever copy carries more page text.
          const existing = sources.find((source) => source.url === entry.url);
          if (existing && (entry.full_content || '').length > (existing.full_content || '').length) Object.assign(existing, entry);
          continue;
        }
        seenUrls.add(entry.url);
        sources.push({ ...entry, title: entry.title || entry.url, url: entry.url, snippet: entry.snippet || '' });
      }
      run.observations.push({
        name: 'web_search',
        args: { query: args.rawPrompt, mode },
        success: true,
        summary: [
          `Search query: ${compactText(args.rawPrompt, 180)}`,
          ...sources.slice(0, 12).map((s, i) => `${i + 1}. ${s.title} - ${s.url}${s.snippet ? ` - ${compactText(s.snippet, 280)}` : ''}`)
        ].join('\n'),
        sources: [...sources]
      });
      gathered = true;
      step.status = 'done';
      step.detail = say.sources(sources.length);
      injectLiveEvidence(run);
      run.messages.push({
        role: 'user',
        content: [
          `System already ran an initial ${mode} web search for the user query and collected ${sources.length} sources (with page text when available).`,
          hasEnoughResearchEvidence(mode, sources)
            ? 'Evidence is sufficient. Write the final APA 7 research report now. Do NOT call tools unless a critical source is clearly missing full text — then fetch_url once.'
            : 'If sources look thin or off-topic, you may run at most one more focused web_search, then write the final APA 7 research report. Prefer fetch_url only for the most important thin URLs.',
          'Never mention tools, step limits, or agent status in the report.'
        ].join('\n')
      });
      args.onSources?.([...sources]);
    } else {
      step.status = 'done';
      step.detail = response.error ? 'Search unavailable — will retry' : 'No results — will refine';
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    // `error`, not `done`: a failed bootstrap search must not look completed.
    step.status = 'error';
    step.detail = 'Search failed — agent will retry';
    debugLog(plan.debugLogs, `[agent] research bootstrap search failed: ${toErrorMessage(err)}`);
  }
  emitSteps(run);
  return gathered;
}
