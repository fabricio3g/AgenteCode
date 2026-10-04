# Local speech measurements

Measured on 2026-10-04 with audio.cpp v0.8.2, Kokoro 82M q8, af_heart, 24 kHz PCM, AMD Radeon Graphics (RADV RENOIR). Each backend/thread setting used a separate server. First request was cold; subsequent requests reused the model. Audio was discarded, not played or uploaded. These are individual observations, not percentile guarantees.

| Backend | Threads | Cold 18 characters | Warm 18 characters | Warm 110 characters |
| --- | ---: | ---: | ---: | ---: |
| CPU | 4 | 4557 ms | 1026 ms | 3544 ms |
| CPU | 8 | 4100 ms | 894 ms | 3300 ms |
| Vulkan | 8 | 4855 ms | 643 ms | 3275 ms |

Splitting the 110-character sentence at its comma produced the first 38-character phrase in 1971 ms, then the remaining 71 characters in 2890 ms. Earlier playback has a throughput tradeoff: total synthesis took longer. The renderer schedules ready clips while the server generates following clips. Long unbroken words are kept intact.

The selected model now loads when the local engine is initialized for a call; other installed models remain lazy. CPU remains the compatibility default. Settings exposes installed CPU/Vulkan runtimes and CPU threads. No GPU superiority is assumed for every machine or model.

Reproduce by starting each bundled audiocpp_server with a temporary configuration, loopback host, unused port, backend and thread setting, the installed model path, task tts and mode offline. Wait for /health, then POST model/input/voice/language to /v1/audio/speech and measure time until the first response byte. Cold numbers include lazy model loading; do not compare them with warm requests. Raw results are alongside this file.

Kokoro is documented as an offline model: https://github.com/0xShug0/audio.cpp/blob/main/docs/models/kokoro_tts.md . The shipped server configuration and backend support are documented at https://github.com/0xShug0/audio.cpp/blob/v0.8.2/app/server/README.md . Streaming here means successive complete phrase clips, not sample streaming inside Kokoro inference.

## Speech recognition and turn submission

The native bundle now includes whisper-server, which is warmed at call start for an installed local model. Cloud providers are not called during warmup. A synthetic 4.125-second Kokoro clip transcribed with ggml-base-q5_1 and four CPU threads measured 1699/1266 ms in separate CLI processes, versus 938/938/1067 ms through the warm server; startup to health took 102 ms. Results are in whisper-call.json. These are observations from this computer, not guarantees for larger models or every backend.

The call distinguishes decoding from submitting: a short pause can start transcription, but sending waits for 1600 ms after the last detected speech frame and all outstanding transcript segments. Resumed speech resets this deadline; partial text never creates a user message. Noise-only recordings are discarded before STT, and explicit non-speech captions are discarded afterwards. Local requests explicitly set translate=false. No upstream changes or submissions are involved.

## Short live inference windows

Live-call PCM16 mono 16 kHz recordings now request a bounded Whisper encoder context instead of padding every short clip to its full 30-second window. The wrapper measures the WAV duration, adds 800 ms of padding, rounds up in 128-position blocks (20 ms per position), and retains a minimum of 256 positions. Long, malformed and unsupported recordings keep the default engine window. Dictation and uploaded media retain their existing behavior.

On the same 4.125-second English fixture, CPU inference measured 927 ms at the default window, 304 ms at 512 positions, and 171/198 ms at 256 positions. Spanish with automatic language detection measured 1853 ms at the default and 1168/592 ms at 512, preserving the complete Spanish transcript. The longer English fixture measured 1073 ms at the default and 738/768 ms at 1024, retaining the final sentence. Compare normalized transcripts, not just latency; these are samples, not statistical accuracy guarantees. Full raw results are in whisper-context.json, whisper-spanish.json and whisper-long.json.

Speech output prepares one following clip while the current clip plays, including request correlation, cancellation and ordered-completeness checks. This overlaps inference with playback; it does not claim Kokoro provides native sample-by-sample streaming. Everything is patched in this repository; no upstream submission is involved.

The exact adaptive sizes (384 positions for the 6.475-second Spanish clip, 768 for the 13.05-second English clip) were also verified. Full transcripts were retained in each repeat. These runs overlapped renderer validation and show contention: Spanish 2399 ms default versus 1426/672 ms adaptive; English 1675 ms default versus 805/734 ms adaptive. See whisper-spanish-adaptive.json and whisper-long-adaptive.json. Do not use the minimum single sample as a percentile promise.
