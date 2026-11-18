import { invoke } from './bridge';

export interface SttTranscribeResult {
  text: string;
}

export interface WhisperRuntime {
  id: string;
  name: string;
  path: string;
  variant: string;
  size_gb: number;
  modified: number;
  is_active: boolean;
}

/**
 * Transcribe audio via the main process (calls OpenAI Whisper API or compatible endpoint).
 */
export async function sttTranscribe(
  audioData: string | Uint8Array | ArrayBuffer,
  mimeType = 'audio/webm',
  options?: { live?: boolean }
): Promise<SttTranscribeResult> {
  // Normalize to Uint8Array if ArrayBuffer
  const bytes = audioData instanceof ArrayBuffer && !(audioData instanceof Uint8Array)
    ? new Uint8Array(audioData)
    : audioData;

  if (bytes instanceof Uint8Array) {
    return invoke<SttTranscribeResult>('stt_transcribe', {
      audio_bytes: bytes,
      mime_type: mimeType,
      live: options?.live === true
    });
  }

  return invoke<SttTranscribeResult>('stt_transcribe', {
    audio_base64: bytes,
    mime_type: mimeType,
      live: options?.live === true
  });
}

export async function listWhisperRuntimes(): Promise<WhisperRuntime[]> {
  return invoke<WhisperRuntime[]>('get_whisper_runtimes');
}

export async function deleteWhisperRuntime(path: string): Promise<{ success: boolean }> {
  return invoke<{ success: boolean }>('delete_whisper_runtime', { path });
}

export async function pickWhisperRuntimeFile(): Promise<string | null> {
  return invoke<string | null>('pick_whisper_runtime_file');
}
