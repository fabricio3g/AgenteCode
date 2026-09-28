# Releasing

One version tag publishes one GitHub release with everything in it:

| Workflow | Builds |
|---|---|
| `release.yml` | Agente Code (`agente`) for Linux x86_64, Linux arm64 and Windows x64, `SHA256SUMS`, `install.sh`, `install.ps1` |
| `desktop-release.yml` | Agente Desktop: Linux AppImage and deb (x86_64), Windows installer (x64) |

## Steps

1. Pick the version, e.g. `0.3.0`, and set it in all three places:
   - `Cargo.toml` → `[workspace.package] version`
   - `apps/desktop/package.json` → `version`
   - `apps/desktop/package-lock.json` → top-level `version` and `packages[""].version`
2. Refresh the lock file and commit:

   ```bash
   CARGO_BUILD_JOBS=2 cargo check -j 2 --workspace
   git commit -am "Release v0.3.0"
   git push
   ```
3. Tag and push the tag:

   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

Both workflows refuse a tag that doesn't match the versions in step 1.
The release notes are generated from the commits since the previous tag;
edit them on the Releases page if needed.

## Notes

- The one-line installers download from `raw.githubusercontent.com` and the
  release assets, so the repository must be public for them to work.
- `install.sh` finds the latest release through the `/releases/latest`
  redirect; `install.ps1` uses the GitHub API. A draft or pre-release is not
  "latest".
- Desktop file names follow `build.artifactName` in
  `apps/desktop/package.json` (`Agente-<version>-<arch>.<ext>`); the
  installers depend on that pattern.
- To try the build without publishing, run the workflows by hand
  (Actions → Run workflow): they build and upload artifacts but skip the
  release.
