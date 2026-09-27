import type { ModelOption } from '../types/chat';

type LocalModelMetadataInput = Pick<
  ModelOption,
  | 'id'
  | 'name'
  | 'path'
  | 'architecture'
  | 'context_length'
  | 'parameter_count'
  | 'size_label'
  | 'quantization_name'
  | 'block_count'
  | 'chat_template_uses_tools'
>;

export function buildLocalModelOption(model: LocalModelMetadataInput, hasMmproj = false): ModelOption {
  return {
    id: model.id,
    name: model.name,
    source: 'local',
    path: model.path,
    details: buildLocalModelSecondaryText(model),
    architecture: model.architecture,
    context_length: model.context_length,
    parameter_count: model.parameter_count,
    size_label: model.size_label,
    quantization_name: model.quantization_name,
    block_count: model.block_count,
    chat_template_uses_tools: model.chat_template_uses_tools,
    has_mmproj: hasMmproj
  };
}

export function formatModelParameterCount(value?: number): string {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) return '';
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B params`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(0)}M params`;
  return `${count} params`;
}

export function formatContextLength(value?: number): string {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) return '';
  if (count >= 1024 && count % 1024 === 0) return `${Math.round(count / 1024)}k`;
  if (count >= 1024) return `${(count / 1024).toFixed(1)}k`;
  return `${count}`;
}

export function buildLocalModelSecondaryText(model: Pick<ModelOption, 'architecture' | 'quantization_name' | 'size_label' | 'details'>): string {
  const parts = [model.architecture, model.quantization_name, model.size_label]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (parts.length) return parts.join(' • ');
  return String(model.details || '').trim();
}

export function getLocalModelSearchFields(model: Pick<ModelOption, 'id' | 'name' | 'details' | 'architecture' | 'quantization_name' | 'size_label'>): string[] {
  return [
    model.id,
    model.name,
    model.details,
    model.architecture,
    model.quantization_name,
    model.size_label
  ]
    .map((value) => String(value || '').toLowerCase().trim())
    .filter(Boolean);
}

export function localModelMatchesSearch(
  model: Pick<ModelOption, 'id' | 'name' | 'details' | 'architecture' | 'quantization_name' | 'size_label'>,
  query: string
): boolean {
  const needle = String(query || '').toLowerCase().trim();
  if (!needle) return true;
  return getLocalModelSearchFields(model).some((field) => field.includes(needle));
}

export function buildLocalModelSummaryChips(
  model: Pick<ModelOption, 'architecture' | 'quantization_name' | 'size_label' | 'parameter_count' | 'context_length' | 'chat_template_uses_tools' | 'has_mmproj'>
): string[] {
  const chips = [model.architecture, model.quantization_name, model.size_label]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const params = formatModelParameterCount(model.parameter_count);
  if (params) chips.push(params);

  const context = formatContextLength(model.context_length);
  if (context) chips.push(`${context} ctx`);

  if (model.chat_template_uses_tools === true) chips.push('Tools supported');
  if (model.chat_template_uses_tools === false) chips.push('No tool template');
  if (model.has_mmproj) chips.push('Vision ready');

  return chips;
}
