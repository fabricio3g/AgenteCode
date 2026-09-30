/** Speech services are configured independently from the conversation model. */
export interface SpeechProviderConfig {
  type: 'openai' | 'elevenlabs' | 'deepgram';
  base_url: string;
  model: string;
  voice?: string;
  api_key?: string;
  has_api_key?: boolean;
}

export interface VoiceAssignment {
  backend?: 'local' | 'api' | 'browser';
  provider?: string;
  voice?: string;
  model?: string;
  language?: string;
  speed?: number;
}

export const SPEECH_DEFAULTS: Record<string, SpeechProviderConfig> = {
  openai: { type: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'coral' },
  compatible: { type: 'openai', base_url: '', model: '', voice: '' },
  elevenlabs: { type: 'elevenlabs', base_url: 'https://api.elevenlabs.io/v1', model: 'eleven_multilingual_v2', voice: '' },
  deepgram: { type: 'deepgram', base_url: 'https://api.deepgram.com/v1', model: 'nova-3' }
};
