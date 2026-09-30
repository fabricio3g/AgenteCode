# Releasing

The next coordinated desktop and Code release is planned in
[Agente 0.2.2 release plan](RELEASE_PLAN_0.2.2.md), including the desktop
packaging failures that must be resolved before tagging.

One version tag publishes one GitHub release with everything in it:

| Workflow | Builds |
|---|---|
| `release.yml` | Agente Code as plain executables: `agente-linux-x86_64`, `agente-linux-arm64`, `agente-windows-x86_64.exe`, and `SHA256SUMS` |
| `desktop-release.yml` | Agente Desktop: `Agente-linux-x86_64.AppImage`, `Agente-linux-amd64.deb`, `Agente-win-x64.exe` |

## Steps

1. Pick the version, e.g. `0.2.2`, and set it in all three places:
   - `Cargo.toml` → `[workspace.package] version`
   - `apps/desktop/package.json` → `version`
   - `apps/desktop/package-lock.json` → top-level `version` and `packages[""].version`
2. Refresh the lock file and commit:

   ```bash
   CARGO_BUILD_JOBS=2 cargo check -j 2 --workspace
    git commit -am "Release v0.2.2"
   git push
   ```
3. Tag and push the tag:

   ```bash
    git tag v0.2.2
    git push origin v0.2.2
   ```

Both workflows refuse a tag that doesn't match the versions in step 1.
The release notes are generated from the commits since the previous tag;
edit them on the Releases page if needed.

## Notes

- File names don't carry the version, so
  `https://github.com/fabricio3g/AgenteCode/releases/latest/download/<file>`
  always points at the newest release. Anonymous downloads need the
  repository to be public.
- Desktop file names come from `build.artifactName` in
  `apps/desktop/package.json` (`Agente-${os}-${arch}.${ext}`).
- Desktop bundles llama.cpp and whisper.cpp from their own GitHub releases
  (`scripts/fetch-native-runtimes.mjs`); nothing native is compiled.
- To try the build without publishing, run the workflows by hand
  (Actions → Run workflow): they build and upload artifacts but skip the
  release.
