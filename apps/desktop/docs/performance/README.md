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
