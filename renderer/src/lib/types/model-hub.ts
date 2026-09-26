import type { HardwareInfo } from '$lib/types/bridge';

export type ModelHubTab = 'discover' | 'library' | 'active';

export interface RuntimeRequirement {
  minVersion?: string;
  architectures: string[];
  reason?: string;
}

export interface RuntimeCapabilities {
  version?: string;
  build?: string;
  supportedArchitectures?: string[];
}

export interface ModelArtifact {
  filename: string;
  quantization: string;
  sizeBytes: number;
  projectorBytes?: number;
  recommended?: boolean;
}

export interface CuratedModelDefinition {
  id: string;
  name: string;
  upstreamRepository: string;
  ggufRepository: string;
  role: string;
  parametersB: number;
  architecture: string;
  capabilities: string[];
  license: string;
  access: 'public' | 'gated';
  defaultQuant: string;
  artifacts: ModelArtifact[];
  projectorRequired?: boolean;
  runtime: RuntimeRequirement;
  rank: number;
  lastReviewed: string;
}

export type ModelFitStatus =
  | 'excellent'
  | 'good'
  | 'constrained'
  | 'unlikely'
  | 'runtime_update'
  | 'unknown';

export interface ModelFitAssessment {
  status: ModelFitStatus;
  reason: string;
  artifactBytes: number;
  projectorBytes: number;
  estimatedWorkingMemoryBytes: number;
  usableMemoryBytes?: number;
  currentlyFreeMemoryBytes?: number;
  offload: 'full_gpu' | 'partial_gpu' | 'cpu' | 'unified' | 'unknown';
}

export interface AssessModelFitInput {
  artifact: Pick<ModelArtifact, 'sizeBytes' | 'projectorBytes'>;
  parametersB?: number;
  architecture?: string;
  hardware?: HardwareInfo | null;
  runtime?: RuntimeCapabilities | null;
  requirement?: RuntimeRequirement;
}

export interface ModelRecommendations {
  fastest?: CuratedModelDefinition;
  balance?: CuratedModelDefinition;
  quality?: CuratedModelDefinition;
  defaultModel: CuratedModelDefinition;
}
