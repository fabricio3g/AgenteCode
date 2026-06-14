export type AggregatorEngineId =
  | 'duckduckgo'
  | 'wikipedia'
  | 'qwant'
  | 'sepiasearch'
  | 'bing'
  | 'brave'
  | 'startpage'
  | 'mojeek'
  | 'yahoo'
  | 'librex'
  | 'searxng';

export const DEFAULT_AGGREGATOR_ENGINES: AggregatorEngineId[] = ['duckduckgo', 'wikipedia'];

export const SUPPORTED_AGGREGATOR_ENGINES: AggregatorEngineId[] = [
  'duckduckgo',
  'wikipedia',
  'qwant',
  'sepiasearch',
  'bing',
  'brave',
  'startpage',
  'mojeek',
  'yahoo',
  'librex',
  'searxng',
];

export const AGGREGATOR_USER_AGENT = 'Chatea/1.0 (local search aggregator)';
