import type { ToolResult } from '$lib/services/agent-types';
import type { ToolContext } from '$lib/services/agent-types';
import {
  getArtifactDefinitionByToolName,
  isArtifactToolEnabled,
  parseArtifactToolArgs,
  type ArtifactToolName
} from '$lib/services/artifact-registry';
import {
  handleCreateChart,
  handleCreateDashboard,
  handleCreateDiagram,
  handleCreateHtmlCard,
  handleCreateWidget,
  handleCreateInfoCard,
  handleCreateLesson,
  handleCreateMap,
  handleCreateReport,
  handleCreateWorkProduct
} from '$lib/services/agent-tool-artifacts';
import { lessonsEnabled } from '$lib/services/lesson-surface';
import {
  handleCreateDocument,
  handleCreatePdf,
  handleCreatePresentation,
  handleCreateSpreadsheet
} from '$lib/services/agent-tool-generators';

type Handler = (params: never) => ToolResult | Promise<ToolResult>;
type RuntimeFor<T extends Handler> = Omit<Parameters<T>[0], 'args' | 'ctx'>;

export type ArtifactToolRuntime =
  RuntimeFor<typeof handleCreateReport>
  & RuntimeFor<typeof handleCreateWorkProduct>
  & RuntimeFor<typeof handleCreateDocument>
  & RuntimeFor<typeof handleCreateSpreadsheet>
  & RuntimeFor<typeof handleCreatePresentation>
  & RuntimeFor<typeof handleCreatePdf>
  & RuntimeFor<typeof handleCreateInfoCard>
  & RuntimeFor<typeof handleCreateHtmlCard>
  & RuntimeFor<typeof handleCreateWidget>
  & RuntimeFor<typeof handleCreateLesson>
  & RuntimeFor<typeof handleCreateChart>
  & RuntimeFor<typeof handleCreateDiagram>
  & RuntimeFor<typeof handleCreateMap>
  & RuntimeFor<typeof handleCreateDashboard>;

type ArtifactExecutor = (args: Record<string, unknown>, ctx: ToolContext, runtime: ArtifactToolRuntime) => ToolResult | Promise<ToolResult>;

function invoke<T extends Handler>(handler: T, args: Record<string, unknown>, ctx: ToolContext, runtime: ArtifactToolRuntime): ReturnType<T> {
  return handler({ ...runtime, args, ctx } as Parameters<T>[0]) as ReturnType<T>;
}

const executors = {
  create_report: (args, ctx, runtime) => invoke(handleCreateReport, args, ctx, runtime),
  create_work_product: (args, ctx, runtime) => invoke(handleCreateWorkProduct, args, ctx, runtime),
  create_document: (args, ctx, runtime) => invoke(handleCreateDocument, args, ctx, runtime),
  create_spreadsheet: (args, ctx, runtime) => invoke(handleCreateSpreadsheet, args, ctx, runtime),
  create_presentation: (args, ctx, runtime) => invoke(handleCreatePresentation, args, ctx, runtime),
  create_pdf: (args, ctx, runtime) => invoke(handleCreatePdf, args, ctx, runtime),
  create_info_card: (args, ctx, runtime) => invoke(handleCreateInfoCard, args, ctx, runtime),
  create_html_card: (args, ctx, runtime) => invoke(handleCreateHtmlCard, args, ctx, runtime),
  create_widget: (args, ctx, runtime) => invoke(handleCreateWidget, args, ctx, runtime),
  create_lesson: (args, ctx, runtime) => invoke(handleCreateLesson, args, ctx, runtime),
  create_chart: (args, ctx, runtime) => invoke(handleCreateChart, args, ctx, runtime),
  create_diagram: (args, ctx, runtime) => invoke(handleCreateDiagram, args, ctx, runtime),
  create_map: (args, ctx, runtime) => invoke(handleCreateMap, args, ctx, runtime),
  create_dashboard: (args, ctx, runtime) => invoke(handleCreateDashboard, args, ctx, runtime)
} satisfies Record<ArtifactToolName, ArtifactExecutor>;

export async function dispatchArtifactTool(
  toolName: string,
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
  runtime: ArtifactToolRuntime
): Promise<ToolResult | null> {
  if (!getArtifactDefinitionByToolName(toolName)) return null;
  if (!isArtifactToolEnabled(toolName, ctx.artifactToggles || {})) {
    return runtime.fail(
      `The ${toolName} tool is disabled in settings.`,
      'Answer without this artifact type, or ask the user to re-enable it.'
    );
  }
  // Home-only types are refused here as well as filtered from the tool list: a
  // call composed from earlier context must not slip a lesson into Code.
  if (toolName === 'create_lesson' && !lessonsEnabled(ctx.contextMode)) {
    return runtime.fail(
      'Lessons are available in Home only.',
      'Answer in prose here. The user can ask for a lesson in Home.'
    );
  }
  const parsed = parseArtifactToolArgs(toolName, rawArgs);
  if (!parsed.success) {
    return runtime.fail(parsed.error, 'Correct the artifact arguments and retry without inventing missing content.');
  }
  const definition = getArtifactDefinitionByToolName(toolName)!;
  const result = await executors[toolName as ArtifactToolName](parsed.data, ctx, runtime);
  if (!result.success || !result.createdFiles?.length) return result;

  const issues = [
    ...(parsed.warnings ?? []),
    ...(parsed.repaired ? [{
      code: 'artifact.arguments_repaired',
      severity: 'warning' as const,
      message: 'The model output used a known alternate shape and was safely normalized.'
    }] : [])
  ];

  /*
   * The manifest is attached to the result, not written back onto `ctx`. The old
   * code mutated `ctx.artifactManifest` and only restored it on the failure path,
   * so a successful call left its manifest behind for whatever built an artifact
   * next — a `get_weather` card following a `create_chart` was published as a chart.
   */
  return {
    ...result,
    artifactManifest: {
      schemaVersion: 1,
      kind: definition.id,
      presentation: definition.presentation,
      entryPath: result.createdFiles[0],
      status: parsed.repaired ? 'partial' : 'ready',
      ...(issues.length ? { issues } : {})
    }
  };
}

export function hasArtifactExecutor(toolName: string): toolName is ArtifactToolName {
  return toolName in executors;
}
