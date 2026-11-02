import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/app.svelte', () => ({ appStore: { composer: 'Home draft', config: {}, updateComposer: vi.fn(), sendCurrentMessage: vi.fn() } }));
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: { error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('$lib/stores/tts.svelte', () => ({ ttsStore: { stop: vi.fn() } }));
vi.mock('$lib/services/bridge', () => ({ invoke: vi.fn(), listen: vi.fn(), isElectron: () => false }));
vi.mock('$lib/services/stt', () => ({ sttTranscribe: vi.fn() }));
vi.mock('./mic-probe', () => ({ requestMicrophone: vi.fn() }));

import { appStore } from '$lib/stores/app.svelte';
import { requestMicrophone } from './mic-probe';
import { Dictation } from './use-dictation.svelte';

class Recognition {
  static latest: Recognition | undefined;
  continuous = false; interimResults = false; lang = '';
  onresult: ((event: any) => void) | null = null;
  onerror: (() => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { Recognition.latest = this; }
  start() {} stop() {} abort() {}
}

describe('dictation composer target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Recognition.latest = undefined;
    vi.stubGlobal('window', { SpeechRecognition: Recognition });
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the transcript to the owning composer rather than the Home draft', async () => {
    vi.mocked(requestMicrophone).mockRejectedValue(new Error('no analyser'));
    const append = vi.fn();
    const dictation = new Dictation(append);
    dictation.toggle();
    await vi.waitFor(() => expect(Recognition.latest).toBeDefined());
    Recognition.latest!.onresult?.({ results: [Object.assign([{ transcript: '  fix the test  ' }], { isFinal: true })] });
    expect(append).toHaveBeenCalledWith('fix the test');
    expect(appStore.updateComposer).not.toHaveBeenCalled();
    dictation.dispose();
    Recognition.latest!.onresult?.({ results: [Object.assign([{ transcript: 'late' }], { isFinal: true })] });
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('releases a microphone granted after the composer has closed', async () => {
    let grant!: (stream: MediaStream) => void;
    vi.mocked(requestMicrophone).mockReturnValue(new Promise(resolve => { grant = resolve; }));
    const stopped = vi.fn();
    const dictation = new Dictation(vi.fn());
    dictation.toggle();
    dictation.dispose();
    grant({ getTracks: () => [{ stop: stopped }] } as unknown as MediaStream);
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
    expect(Recognition.latest).toBeUndefined();
  });
});
