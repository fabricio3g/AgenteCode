import type { ToolResult } from '$lib/services/agent-types';
import type { ToolContext } from '$lib/services/agent-types';
import {
  getArtifactDefinitionByToolName,
  parseArtifactToolArgs,
  type ArtifactToolName
} from '$lib/services/artifact-registry';
import {
  handleCreateChart,
  handleCreateDashboard,
  handleCreateDiagram,
  handleCreateHtmlCard,
  handleCreateInfoCard,
  handleCreateMap,
  handleCreateReport,
  handleCreateWorkProduct,
  handleExportResearchPackage
} from '$lib/services/agent-tool-artifacts';
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
  & RuntimeFor<typeof handleExportResearchPackage>
  & RuntimeFor<typeof handleCreateInfoCard>
  & RuntimeFor<typeof handleCreateHtmlCard>
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
  export_research_package: (args, ctx, runtime) => invoke(handleExportResearchPackage, args, ctx, runtime),
  create_info_card: (args, ctx, runtime) => invoke(handleCreateInfoCard, args, ctx, runtime),
  create_html_card: (args, ctx, runtime) => invoke(handleCreateHtmlCard, args, ctx, runtime),
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
  const parsed = parseArtifactToolArgs(toolName, rawArgs);
  if (!parsed.success) {
    return runtime.fail(parsed.error, 'Correct the artifact arguments and retry without inventing missing content.');
  }
  const definition = getArtifactDefinitionByToolName(toolName)!;
  const previousManifest = ctx.artifactManifest;
  ctx.artifactManifest = {
    schemaVersion: 1,
    kind: definition.id,
    presentation: definition.presentation,
    status: parsed.repaired ? 'partial' : 'ready',
    ...(parsed.repaired ? {
      issues: [{
        code: 'artifact.arguments_repaired',
        severity: 'warning' as const,
        message: 'The model output used a known alternate shape and was safely normalized.'
      }]
    } : {})
  };
  const result = await executors[toolName as ArtifactToolName](parsed.data, ctx, runtime);
  if (!result.success || !result.createdFiles?.length) {
    ctx.artifactManifest = previousManifest;
    return result;
  }
  ctx.artifactManifest = {
    ...ctx.artifactManifest,
    entryPath: result.createdFiles[0]
  };
  return result;
}

export function hasArtifactExecutor(toolName: string): toolName is ArtifactToolName {
  return toolName in executors;
}
