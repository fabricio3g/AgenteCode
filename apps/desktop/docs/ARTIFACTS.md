# Artifact editing and private previews

Open an artifact's studio to inspect its files, edit text sources, save changes to
the original chat message, or download individual files / a ZIP. Selecting a file
opens its source; the Preview tab shows the artifact's entry document.

HTML previews embedded in chat and document readers are static. **Run preview**
in the studio opens interactive HTML/JavaScript in an offline Electron window.
Local CSS, scripts and supported images from the artifact are bundled into the
preview; remote dependencies are blocked. Source files and downloads retain their
original contents.

## Isolation boundary

- Each native preview and PDF-rendering window gets a fresh, memory-only session.
- Guests have no preload bridge, Node integration or shared app cookies.
- Chromium sandboxing and context isolation are enabled on guest windows.
- Network emulation is offline, with request blocking as an additional layer.
- Permissions, downloads, popups, external navigation and nested webviews are denied.
- Content Security Policy restricts assets to local data URLs and blocks connections,
  frames, workers, forms and plugins. Embedded previews also disable scripts.
- PDF rendering disables JavaScript, times out, and destroys its window on success
  or failure. Rendering errors propagate rather than silently replacing the document.

Document generation preserves report tables in Markdown, HTML, DOCX and HTML-based
PDF exports. Unsupported output formats return an error. Editing a preview's source
does not regenerate an existing binary document; regenerate that document to update it.

## Focused verification

```sh
cd renderer
npx vitest run src/lib/utils/preview-builder.spec.ts src/lib/services/generated-documents.spec.ts src/lib/ui/components/CodeEditor.spec.ts
```

From the repository root:

```sh
npx tsx --test tests/unit/generated-document-tables.test.js tests/unit/xlsx-sheet-names.test.js
npx esbuild tests/electron/artifact-preview.smoke.ts --bundle --platform=node --format=cjs --external:electron --outfile=/tmp/opencode/artifact-preview-smoke.cjs
npx electron /tmp/opencode/artifact-preview-smoke.cjs
```

The Electron smoke test requires a working desktop display and Electron sandbox
setup. It verifies real Chromium request blocking, app-session separation, script
execution, blocked navigation/popups, PDF creation, error cleanup and timeouts.
