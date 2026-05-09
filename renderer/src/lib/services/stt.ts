import { invoke } from './tauri';

export interface SttTranscribeResult {
  text: string;
}

export interface SttStatus {
  provider: string;
  model: string;
  ready: boolean;
  whisper_quality: string;
  local_available: boolean;
  loaded: boolean;
}

/**
 * Transcribe audio via the main process (calls OpenAI Whisper API or compatible endpoint).
 */
export async function sttTranscribe(
  audioData: string | Uint8Array | ArrayBuffer,
  mimeType = 'audio/webm'
): Promise<SttTranscribeResult> {
  // Normalize to Uint8Array if ArrayBuffer
  const bytes = audioData instanceof ArrayBuffer && !(audioData instanceof Uint8Array)
    ? new Uint8Array(audioData)
    : audioData;

  if (bytes instanceof Uint8Array) {
    return invoke<SttTranscribeResult>('stt_transcribe', {
      audio_bytes: bytes,
      mime_type: mimeType
    });
  }

  return invoke<SttTranscribeResult>('stt_transcribe', {
    audio_base64: bytes,
    mime_type: mimeType
  });
}

async function getSttStatus(): Promise<SttStatus> {
  return invoke<SttStatus>('get_stt_status');
}

export async function unloadWhisper(): Promise<void> {
  return invoke<void>('unload_whisper');
}

/**
 * Record audio from the microphone and return base64-encoded audio data.
 * Uses MediaRecorder API. Returns base64 string and the MIME type used.
 */
function recordAudio(
  deviceId?: string,
  maxMs = 30_000
): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const constraints: MediaStreamConstraints = deviceId
      ? { audio: { deviceId: { exact: deviceId } } }
      : { audio: true };

    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg';

      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(',')[1];
          resolve({ base64, mimeType: mimeType.split(';')[0] });
        };
        reader.onerror = () => reject(new Error('Failed to read audio data'));
        reader.readAsDataURL(blob);
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        reject(new Error('MediaRecorder error'));
      };

      recorder.start();
      setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, maxMs);

      // Keep parity with existing recorder extension behavior.
      const recorderWithStop = recorder as MediaRecorder & { _stopFn?: () => void };
      recorderWithStop._stopFn = () => {
        if (recorder.state !== 'inactive') recorder.stop();
      };
    }).catch(reject);
  });
}
