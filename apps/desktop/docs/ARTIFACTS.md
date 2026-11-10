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

## Lesson artifacts

A lesson is an inline, Home-only teaching artifact: `create_lesson` writes one JSON
payload whose `blocks` the model composes (`pretest`, `explore`, `predict`,
`choice`, `numeric`, `steps`, `reveal`, `figure`, `summary`). The app owns the
interaction, the feedback and the layout; the model supplies data.

Rules the implementation enforces rather than hopes for:

- **Off by default.** `lesson` has `defaultEnabled: false`. The first `/teach` or
  `/practice` in Home turns it on; Settings → Artifact types can turn it off again.
- **Home only.** `lessonsEnabled(contextMode)` gates the tool definition
  (`selectToolDefs`), the dispatcher (`dispatchArtifactTool`) and every UI entry
  point. Opened from the library in another space, a lesson renders read-only.
- **Only when asked.** There is no keyword enforcement for lessons. The user asks
  with `/teach`, `/practice`, or the `Teach me this` / `Practise this` message
  actions — those fill the composer with a directive and never send it.
- **Pedagogy lint.** `lintLesson` runs after the zod schema normalises the call:
  a lesson must open with a question, end with a summary, give every wrong option
  its own `why`, keep explanation runs to two blocks, avoid hints or `explore` in
  practice mode, and give fractional answers a tolerance. Errors fail the tool
  call with a fix-it message; length warnings land on the manifest as
  `artifact.pedagogy`.
- **No scoring.** The runner state holds `index`, `answers`, `hints`, `submitted`
  only — no score, points, streak or percentage is tracked or rendered anywhere.
- **Safe expressions.** `explore` outputs and plots are evaluated by
  `ui/components/simulation-model.ts` (no `eval`, no `new Function`); an unusable
  expression renders a dash, never a crash.
- **Silent resume.** Progress is one index per artifact entry path in
  `localStorage` (`agente:lesson-progress:v1`, newest 200). Reopening lands on
  the same block; nothing is displayed about it.

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
