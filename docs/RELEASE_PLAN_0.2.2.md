# Agente 0.2.2 release plan

Prepared on 2026-09-30. This plan covers **Agente Desktop** and **Agente Code**
from the same commit on `main`, under one GitHub release, `v0.2.2`.
Rust and Desktop versions are set to `0.2.2` for this patch release candidate.

## Scope and artifacts

| Product | Platform | Required assets |
|---|---|---|
| Agente Code | Linux x86_64 | `agente-linux-x86_64` |
| Agente Code | Linux arm64 | `agente-linux-arm64` |
| Agente Code | Windows x64 | `agente-windows-x86_64.exe` |
| Agente Desktop | Linux x64 | AppImage and Debian installer |
| Agente Desktop | Windows x64 | NSIS installer and its update metadata/blockmap |
| Both | All released artifacts | SHA-256 checksums |

Use the actual installer names emitted by `build.artifactName` in
`apps/desktop/package.json` (`Agente-${os}-${arch}.${ext}`), and verify those
names against the README's download links. Desktop bundles `agente` from
the same release commit. The current workflow matrix does not build macOS
or desktop arm64; those are outside this release's supported artifact set.

Release highlights:

- A consistent desktop layout, docks, shared Home/Code composer, and a clearer
  coding transcript with tool receipts and message actions.
- Context usage details and a keyboard/pointer-controlled thinking-effort bar.
- Bots navigation and expanded roleplay controls, with seven-language copy.
- OpenCode Go/Zen session routing, including the desktop provider aliases.
- Local-model loading before Code turns, bounded pre-output provider retries,
  and localized errors with collapsed diagnostics.

## 1. Resolve the desktop packaging blockers

The published `v0.2.1` release currently contains only the three Code binaries
and `SHA256SUMS`. Desktop workflow run
[36536100599](https://github.com/fabricio3g/AgenteCode/actions/runs/36536100599)
failed before its publication job:

| Platform | Observed failure | Required preparation |
|---|---|---|
| Linux | `Write failed because No space left on device` during packaging | Measure disk use before runtime fetch and packaging; reclaim unused runner tooling and disposable build/cache files after bundling, or use a larger runner. If selecting a smaller backend bundle, explicitly document its supported GPU backends. Prove the chosen configuration in a complete dry run. |
| Windows | Repository autodetection failed, followed by `Cannot read properties of null (reading 'channel')` in electron-builder's update metadata code | Add explicit repository and GitHub publish metadata for `fabricio3g/AgenteCode`; keep upload publication owned by the workflow. Verify NSIS, update YAML, and blockmap generation with `--publish=never`. |

Additional publication preparation:

The retry preparation now adds explicit repository/publish metadata, reclaims
Linux runner space (including compiler output after the runtime is bundled),
and checks required installer files before upload. Both workflows stage assets
in a draft release. These changes still need a successful packaging run.

1. Pin and record the llama.cpp, whisper.cpp, and audio.cpp runtime versions.
   Current script defaults are `b11146`, `b5130`, and `v0.8.2`, respectively.
   Confirm any repository-variable overrides and expose the audio tag override
   in CI if it is needed. Download runtime binaries in CI; model weights are
   not release-build prerequisites.
2. Keep missing required assets fatal. Desktop checks each platform's required
   installer and Windows update metadata, and uses `if-no-files-found: error`.
3. Combine the CLI workflow's `SHA256SUMS` with Desktop's
   `DESKTOP_SHA256SUMS` before publication, following `RELEASING.md`.
4. Finalize the shared draft only after both tag-triggered workflows pass and
   all required assets are verified, so a failed desktop build cannot expose
   a new CLI-only release as Latest.
5. Confirm and disclose the signing status of the installers. Previous Windows
   packaging logs reported that signing was skipped.

## 2. Validate the exact release candidate

First land the current UI and provider work on `main`, then wait for its Rust
and Desktop CI checks to pass. Record the candidate commit SHA.

On the memory-constrained development machine, keep Cargo jobs at two and run
one crate at a time. Do not run Clippy and tests together.

```bash
cargo fmt --all -- --check
CARGO_BUILD_JOBS=2 cargo test -p agente-core -j 2
CARGO_BUILD_JOBS=2 cargo test -p agente-tui -j 2
```

Run the other touched crates separately, then run the desktop checks:

```bash
# apps/desktop/renderer
npm run check
npx vitest run

# apps/desktop
npm test
npm run fallow:audit
node scripts/gen-protocol-types.mjs --check
```

CI must also pass warning-denying Clippy and the platform-specific Rust tests.
Refresh Fallow baselines only for established findings whose locations moved,
not to hide new regressions.

Recorded provider verification for the current fixes: two real tool-using
turns per model, reusing each conversation, on Go
`longcat-2.5-preview-free`, Go `space-bunny-free`, and OpenRouter
`stealth/space-bunny-alpha`. All six turns and 18 tool calls succeeded, with
correct generated files. Retry classification and prevention of replay after
partial output are covered by automated tests; these live runs did not
encounter an outage.

## 3. Prepare the version and perform non-publishing builds

Keep `0.2.2` synchronized in:

- `Cargo.toml` (`workspace.package.version`), refreshing the workspace entries
  in `Cargo.lock`.
- `apps/desktop/package.json`.
- `apps/desktop/package-lock.json`, both its top-level version and
  `packages[""].version`.

The renderer's private package version is independent. Verify that both tag
guards accept `v0.2.2`, and commit the synchronized release versions, packaging
fixes, and release notes before tagging.

The current workflows support non-publishing manual runs:

```bash
gh workflow run release.yml --ref main
gh workflow run desktop-release.yml --ref main
```

Both current publication jobs skip a branch-based dispatch. Preserve that
behavior when coordinating publication. Require all three CLI target builds
and both desktop platform builds to succeed; download their artifacts for
the following smoke tests.

## 4. Smoke-test the built artifacts

| Surface | Required verification |
|---|---|
| Standalone Code | Version/help, TUI launch and resize, a real tool-using turn, interruption, and saved-session resume. Run on Linux x86_64 and Windows x64; verify the arm64 binary on an arm64 host. |
| Desktop installation | Fresh install, launch, and upgrade from `0.2.1` without losing existing configuration, credentials, or sessions. Verify Linux AppImage/deb and Windows NSIS. |
| Bundled Code runtime | Start a Code conversation from the packaged app and confirm it starts its bundled `agente`, without depending on a development checkout or a PATH-installed binary. |
| Providers | Repeat the Go LongCat and OpenRouter multi-turn tool smoke tests in packaged Code. |
| Local model | With an already downloaded small model configured and the server stopped, send from Code and verify automatic loading and completion. With no configured model, verify the localized Models guidance. Do not download large models for the test. |
| Errors | Verify summary text and initially collapsed Details, retained partial output, and bounded retry before output using controlled failure injection. |
| Composer and locales | Thinking slider keyboard, pointer, Escape/focus return, reduced motion, and context details. Verify all seven locales, dark/light themes, and basic Home/Bots/roleplay navigation. |

Record installer/binary sizes, checksums, host OS versions, smoke-test results,
and any supported-backend limitations in the release notes.

## 5. Tag, publish, and verify downloads

After all gates above pass, tag the approved commit on `main`:

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.2.2 -m "Agente 0.2.2"
git push origin v0.2.2
```

Combine the two checksum manifests and finish coordinated publication only
when every required asset is available (see `RELEASING.md`).
Verify the release page and anonymous `releases/latest/download/…` URLs,
download the published files, and compare their SHA-256 checksums. Include
clear installation instructions for each platform and the packaging/signing
status established above.

If any required build or smoke test fails, keep the candidate unpublished and
fix it before promoting the release. Preserve already-published version tags;
use the next version for a correction after publication.
