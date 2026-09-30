import type { SpeechProviderConfig } from '../../shared/speech.ts';

function endpoint(provider: SpeechProviderConfig, suffix: string): string {
  const base = provider.base_url?.trim().replace(/\/+$/, '');
  if (!base) throw new Error('Set the speech service endpoint in Settings → Voice.');
  return `${base}/${suffix}`;
}

function headers(provider: SpeechProviderConfig): Record<string, string> {
  return provider.api_key ? provider.type === 'elevenlabs' ? { 'xi-api-key': provider.api_key }
    : { Authorization: `${provider.type === 'deepgram' ? 'Token' : 'Bearer'} ${provider.api_key}` } : {};
}

async function checked(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(`Speech service returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

/** Both adapters return mono, signed 16-bit PCM at the player's 24 kHz. */
export async function synthesizeApi(provider: SpeechProviderConfig, request: { text: string; voice?: string; model?: string; speed?: number; language?: string }, signal: AbortSignal): Promise<Buffer> {
  const voice = request.voice || provider.voice;
  if (!voice) throw new Error('Choose a voice in Settings → Voice or the character editor.');
  const model = request.model || provider.model;
  if (!model) throw new Error('Choose a speech model in Settings → Voice.');
  const eleven = provider.type === 'elevenlabs';
  if (!eleven && provider.type !== 'openai') throw new Error('This provider does not support speech generation.');
  const body = eleven ? { text: request.text, model_id: model, voice_settings: { speed: request.speed ?? 1 },
    ...(request.language && request.language !== 'auto' ? { language_code: request.language } : {}) }
    : { input: request.text, model, voice, speed: request.speed ?? 1, response_format: 'pcm' };
  const response = await checked(await fetch(endpoint(provider, eleven ? `text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_24000` : 'audio/speech'), {
    method: 'POST', headers: { ...headers(provider), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)])
  }));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length % 2) throw new Error('Speech service returned invalid PCM audio.');
  return bytes;
}

export async function transcribeApiAudio(provider: SpeechProviderConfig, bytes: Buffer, mime: string, language?: string, signal?: AbortSignal): Promise<{ text: string }> {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
  let response: Response;
  if (provider.type === 'deepgram') {
    const url = new URL(endpoint(provider, 'listen'));
    url.searchParams.set('model', provider.model || 'nova-3');
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set(language && language !== 'auto' ? 'language' : 'detect_language', language && language !== 'auto' ? language : 'true');
    response = await checked(await fetch(url, { method: 'POST', headers: { ...headers(provider), 'Content-Type': mime }, body: new Uint8Array(bytes), signal: deadline }));
    const data = await response.json();
    const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof text !== 'string') throw new Error('Transcription response is missing its transcript.');
    return { text };
  }
  if (provider.type !== 'openai') throw new Error('This provider does not support transcription.');
  const form = new FormData();
  form.append('model', provider.model || 'whisper-1');
  if (language && language !== 'auto') form.append('language', language);
  const ext = /wav/i.test(mime) ? 'wav' : /mpeg|mp3/i.test(mime) ? 'mp3' : /ogg/i.test(mime) ? 'ogg' : 'webm';
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `recording.${ext}`);
  response = await checked(await fetch(endpoint(provider, 'audio/transcriptions'), { method: 'POST', headers: headers(provider), body: form, signal: deadline }));
  const data = await response.json();
  if (typeof data?.text !== 'string') throw new Error('Transcription response is missing its text.');
  return { text: data.text };
}

export async function apiVoices(provider: SpeechProviderConfig): Promise<Array<{ id: string; name: string }>> {
  if (provider.type === 'openai') return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].map((id) => ({ id, name: id }));
  if (provider.type !== 'elevenlabs') return [];
  const response = await checked(await fetch(endpoint(provider, 'voices'), { headers: headers(provider), signal: AbortSignal.timeout(15000) }));
  const data = await response.json();
  return (data.voices ?? []).map((voice: { voice_id: string; name: string }) => ({ id: voice.voice_id, name: voice.name }));
}
