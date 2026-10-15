# Desktop document ingestion

Home uploads use one attachment ingestion service. Original documents are kept
in Electron's content-addressed attachment store; their canonical Markdown
extractions are cached separately and indexed once. Reusing a file in another
chat reuses its extraction, including the extraction method and reading warnings.
`read_ingested_document` is scoped to a chat holding the indexed document.

## Inputs

| Input | Extraction |
| --- | --- |
| PDF | Positioned text with original page numbers. Mixed/scanned PDFs fall back to per-page PDF.js text extraction and Tesseract OCR. Blank pages keep their numbers and generate a reading warning. |
| DOCX | Mammoth HTML conversion preserves headings, prose and tables. An image-only document can fall back to embedded-image OCR. |
| XLSX / XLSM | ExcelJS reads sheets, row coordinates, dates, rich text and cached formula results. Uncached formulas are explicitly labeled; macros are never executed. |
| CSV / TSV | Quoted-field parsing, including multiline fields. UTF-8 and BOM-marked UTF-16 are supported. |
| PPTX | Slide text with slide numbers. |
| HTML / HTM | Headings, lists, tables, code, inline text and links. Scripts/styles are discarded and nothing executes. |
| ODT / ODS / ODP | OpenDocument text, headings, tables, sheet and slide boundaries. Populated spreadsheet repeats are expanded within a bounded cell budget. |
| EPUB | Chapters are read in spine order; external resources and scripts never run. |
| RTF | Text, paragraphs, escaped characters and Unicode; pictures and formatting destinations are skipped. |
| Text / Markdown / JSON / source code | Text decoding and language fences. Unknown extensions are accepted only when their bytes are readable text. |
| Images | The configured vision path when available; otherwise English Tesseract OCR, indexed for later reading. OCR reads text, not diagrams or other visual meaning. |
| Audio / video | The configured Whisper/speech engine, after FFmpeg resampling and 30-second segmentation. Transcripts carry timestamps. Video extraction covers its audio track only and reports that limitation. |

Legacy binary DOC, XLS and PPT need export to a modern Office format, PDF, CSV or
OpenDocument. Encrypted/corrupt documents fail visibly. The app does not index
empty or undecodable content and does not report a failed OCR/index operation as
ready. OCR errors are distinct from a page with no recognizable text.

Current limits: 512 MB uploads, eight million extracted characters, six-hour
recordings, 32 MB per OpenDocument/EPUB section, and one million populated ODS
cells. Recording bytes are stored as files rather than embedded into chat
history. Inline OCR excerpts are bounded; the document reader retains the full
indexed content. English OCR language data is bundled with the app; no first-use CDN download is needed. PDF rasterization uses print intent so hidden/minimized windows can finish reading. OCR data loading, initialization, rendering and recognition have explicit deadlines.

## From sources to deliverables

The Home agent reads the canonical extraction through `read_document` and
`extract_tables`, preserving page/sheet/slide selection even for OCR. Character offsets and table row offsets let tools continue within a long unit without repeating its first output window. Transcription
tools reuse an indexed transcript. Ingestion guidance is added only when the chat
has indexed sources: read relevant ranges, preserve source values, calculate
rather than guess, cite filenames and locations, and carry reading limitations
into the output. Existing artifact tools produce reports, DOCX, XLSX, slides,
HTML/Markdown and PDF from the evidence-aware work-product schema.

## Verification

Run the renderer regression tests and the main format, import, supervisor and
recording tests. `rag-ingest.test.js` needs Electron's Node ABI to exercise the
actual SQLite registry (ordinary Node may skip these tests):

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron --import tsx --test --test-isolation=none tests/unit/rag-ingest.test.js
```

The live generation smoke uses synthetic HTML, Excel and transcript fixtures,
the real artifact schema/generators, then re-ingests the resulting Markdown,
HTML, DOCX and XLSX to verify values and source attribution. It accepts only a
currently listed `:free` model or `openrouter/free` with zero catalog prices and
never falls back to a paid model. Credentials come from `OPENROUTER_API_KEY`, a
readable app configuration, or the user's configured OpenCode key; keys are never
printed. Encrypted app credentials require running through Electron or supplying
the environment variable.

```sh
TSX_TSCONFIG_PATH=renderer/tsconfig.json node --import tsx scripts/smoke-document-ingestion.ts
```

`tests/electron/document-ingestion.smoke.ts` exercises a real mixed PDF, Tesseract
worker, indexing, page-range reading and artifact generation through production
IPC. Serve the renderer on port 5178; bundle the harness with esbuild, externalize
Electron/native packages, and run it with Electron. Place the bundle where Node
can resolve the app's installed packages (or provide a scratch `node_modules`
symlink). `AGENTE_DEV_URL` and `AGENTE_INGEST_OUTPUT` override the preview and
output locations. `tests/electron/ocr-assets.smoke.cjs` verifies the production OCR chunk with every HTTP(S) request blocked; build the renderer first, then run it with Electron from `apps/desktop`.

## Generic GGUF loading

Model import validates the GGUF header and registers files in place or copies
all shards after checking for destination collisions. Models outside the managed
folder are included in discovery. Split files become one library entry pointing
at their first shard; projectors are selected separately in the load dialog.
Architecture support is delegated to the installed llama.cpp runtime, with no
app-side model-family allowlist. Embedded/sidecar templates and runtime flag
capability probes remain in effect.

Cold model loads have a ten-minute watchdog and remain cancellable. CPU selection
is honored even when the runtime offers GPU backends. New load settings default
to mmap without memory locking; explicit saved lock preferences still apply.
Unsupported architectures are reported as runtime compatibility failures.

The real-model smoke loads and requests an answer on a separate port, using a
temporary configuration and cleaning up its own server:

```sh
AGENTE_TEST_MODEL=/path/model.gguf AGENTE_TEST_RUNTIME=/path/llama-server node --import tsx scripts/smoke-local-model.mjs
```

`AGENTE_TEST_CONTEXT` changes its 4096-token default. This test accepts any GGUF
that the selected llama.cpp build supports; no model name is hardcoded.
