import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { synthesizeApi, transcribeApiAudio, apiVoices } from '../../main/voice/speech-api.ts';
import { SecretsManager, MemoryCryptoProvider } from '../../main/config.secrets.ts';
import { redactConfig } from '../../main/config.redact.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('speech adapters send the correct protocols and preserve returned PCM/transcripts', async () => {
  const calls = [];
  const pcm = Buffer.from([0, 0, 255, 127]);
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ url: request.url, headers: request.headers, body });
    if (request.url.includes('audio/speech') || request.url.includes('text-to-speech')) { response.end(pcm); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/v1/voices' ? { voices: [{ voice_id: 'voice-one', name: 'Voice One' }] } : request.url.startsWith('/v1/listen') ? { results: { channels: [{ alternatives: [{ transcript: 'Hello Wren.' }] }] } } : { text: 'Hello Rachel.' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base_url = `http://127.0.0.1:${server.address().port}/v1`;
  const openai = { type: 'openai', base_url, api_key: 'test-openai', model: 'tts-test', voice: 'coral' };
  const eleven = { type: 'elevenlabs', base_url, api_key: 'test-eleven', model: 'eleven-test', voice: 'voice-one' };
  try {
    assert.deepEqual(await synthesizeApi(openai, { text: 'Hello.', speed: 1.2 }, new AbortController().signal), pcm);
    assert.equal(calls[0].headers.authorization, 'Bearer test-openai');
    assert.equal(JSON.parse(calls[0].body).response_format, 'pcm');
    assert.equal(JSON.parse(calls[0].body).voice, 'coral');
    assert.deepEqual(await synthesizeApi(eleven, { text: 'Hi.' }, new AbortController().signal), pcm);
    assert.match(calls[1].url, /output_format=pcm_24000/);
    assert.equal(calls[1].headers['xi-api-key'], 'test-eleven');
    assert.deepEqual(await apiVoices(eleven), [{ id: 'voice-one', name: 'Voice One' }]);
    assert.deepEqual(await transcribeApiAudio({ ...openai, model: 'whisper-1' }, pcm, 'audio/wav', 'en'), { text: 'Hello Rachel.' });
    assert.match(calls[3].headers['content-type'], /multipart\/form-data; boundary=/);
    assert.match(calls[3].body.toString(), /name="language"\r\n\r\nen/);
    assert.deepEqual(await transcribeApiAudio({ type: 'deepgram', base_url, api_key: 'test-deepgram', model: 'nova-3' }, pcm, 'audio/wav', 'auto'), { text: 'Hello Wren.' });
    assert.equal(calls[4].headers.authorization, 'Token test-deepgram');
    assert.deepEqual(calls[4].body, pcm);
    assert.match(calls[4].url, /detect_language=true/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('speech credentials encrypt independently and never cross the renderer config boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-speech-keys-'));
  try {
    const manager = new SecretsManager(new MemoryCryptoProvider(), { secretsPath: path.join(dir, 'secrets.json') });
    const config = { llm: { providers: {} }, tts: { providers: { openai: { api_key: 'tts-key' } } }, stt: { providers: { deepgram: { api_key: 'stt-key' } } } };
    manager.saveApiKeysToSecrets(config);
    assert.equal(config.tts.providers.openai.api_key, '');
    assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('tts-key'));
    manager.injectApiKeysFromSecrets(config);
    assert.equal(config.tts.providers.openai.api_key, 'tts-key');
    assert.equal(config.stt.providers.deepgram.api_key, 'stt-key');
    const redacted = redactConfig(config);
    assert.equal(redacted.tts.providers.openai.api_key, undefined);
    assert.equal(redacted.stt.providers.deepgram.api_key, undefined);
    assert.equal(redacted.tts.providers.openai.has_api_key, true);
    assert.equal(config.tts.providers.openai.api_key, 'tts-key');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an aborted speech request does not produce audio', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(synthesizeApi({ type: 'openai', base_url: 'http://127.0.0.1:1/v1', model: 'tts-test', voice: 'coral' }, { text: 'Hello.' }, controller.signal), /abort/i);
});
