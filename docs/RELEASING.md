# Releasing

The [Agente 0.2.2 release record](RELEASE_PLAN_0.2.2.md) documents the
coordinated desktop and Code release, including the packaging fixes and
validation checklist.

One version tag builds both products into a shared draft GitHub release:

| Workflow | Builds |
|---|---|
| `release.yml` | Agente Code as plain executables: `AgenteCode-linux-x64`, `AgenteCode-linux-arm64`, `AgenteCode-windows-x64.exe`, Debian packages for amd64/arm64, and `AgenteCode-SHA256SUMS` |
| `desktop-release.yml` | Agente Desktop: `AgenteDesktop-linux-x64.AppImage`, `AgenteDesktop-linux-amd64.deb`, `AgenteDesktop-windows-x64.exe`, and `AgenteDesktop-SHA256SUMS` |

## Steps

1. Pick the next version, e.g. `0.2.3`, and set it in all three places:
   - `Cargo.toml` → `[workspace.package] version`
   - `apps/desktop/package.json` → `version`
   - `apps/desktop/package-lock.json` → top-level `version` and `packages[""].version`
2. Refresh the lock file and commit:

   ```bash
   CARGO_BUILD_JOBS=2 cargo check -j 2 --workspace
   git commit -am "Release v0.2.3"
   git push
   ```
3. Tag and push the tag:

   ```bash
   git tag -a v0.2.3 -m "Agente 0.2.3"
   git push origin v0.2.3
   ```

Both workflows refuse a tag that doesn't match the versions in step 1.
The release notes are generated from the commits since the previous tag;
edit them on the Releases page if needed.

4. Wait for both release workflows to succeed and verify that the draft has
   all three Code binaries, both Code Debian packages, both Linux desktop installers, and the Windows
   desktop installer with `latest.yml` and its blockmap. Each workflow writes
   checksums for its own assets. Verify both files before publishing:

   ```bash
   mkdir -p release-checksums
   gh release download v0.2.3 --pattern 'AgenteCode-*' --pattern 'AgenteDesktop-*' --pattern 'latest*.yml' --dir release-checksums
   (cd release-checksums && sha256sum -c AgenteCode-SHA256SUMS && sha256sum -c AgenteDesktop-SHA256SUMS)
   gh release edit v0.2.3 --draft=false --latest
   ```

   Publish after the artifact checks and available packaged-app smoke tests;
   a failed build stays a draft. Drafts are visible to repository maintainers,
   but do not appear in the public Releases list or count.

## Notes

- File names don't carry the version, so
  `https://github.com/fabricio3g/AgenteCode/releases/latest/download/<file>`
  always points at the newest release. Anonymous downloads need the
  repository to be public.
- Desktop file names come from `build.artifactName` in
  `apps/desktop/package.json`, with target-specific overrides for Windows and AppImage. Debian uses Debian architecture names (`amd64`, `arm64`).
- Desktop bundles llama.cpp and whisper.cpp from their own GitHub releases
  (`scripts/fetch-native-runtimes.mjs`); nothing native is compiled.
- To try the build without publishing, run the workflows by hand
  (Actions → Run workflow): they build and upload artifacts but skip the
  release.
- Desktop manual runs can select Linux or Windows. For verification retries,
  `code_run_id` can reuse a successful Code workflow's binary; checksums and
  unchanged Rust sources, Cargo files, and embedded assets are required. Tag
  builds compile their own runtime. Startup tests run before installer compression.

- Packaged startup tests gate both Desktop upload jobs. They use temporary profiles, verify configuration IPC, a Monaco TypeScript worker and the bundled Rust binary, and exercise failure screens. Diagnostics are uploaded even on failure.
- Desktop size reports separate installed size, installer size, renderer assets, dependencies and every native backend. All GPU runtimes remain bundled; production source maps and proven duplicate dependencies are excluded.
- Existing releases keep their original names. These names apply to releases built after this change.
