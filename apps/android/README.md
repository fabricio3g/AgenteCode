# Agente Android

Native Kotlin / Jetpack Compose client with a Rust provider adapter. No Electron,
JavaScript runtime or application WebView is used. Android stores chats and
characters in Room; credential values are encrypted with an Android Keystore key.

## The phone wears the desktop's design language

The interface is not a Material app with Agente colours. It draws the same
planes, the same type ladder, the same one accent and the same motion ladder the
Electron renderer and the TUI use, and it gets those numbers by generation rather
than by imitation:

| Generated from | Into | Guard |
| --- | --- | --- |
| `renderer/src/app.css`, `shared/window-theme.ts` | `ui/design/AgenteTokens.kt`, `res/values{,-night}/colors.xml` | `gen-tokens.mjs --check` |
| `lucide-svelte` (the desktop's own icon package) | `res/drawable/agente_ic_*.xml` | `gen-icons.mjs --check` |
| `renderer/src/lib/copy/**`, `renderer/src/lib/locales/*.json` | `res/values{,-es,-pt-rBR,-fr,-de,-ja,-zh}/copy.xml` | `gen-strings.mjs --check` |

```sh
node apps/android/scripts/gen-tokens.mjs      # rewrite, or --check to verify
node apps/android/scripts/gen-icons.mjs
node apps/android/scripts/gen-strings.mjs
```

CI runs all three with `--check`, so a desktop token, glyph or string change the
phone has not picked up fails the build instead of shipping a second palette.

`ui/design/` is the phone's whole component library: `AgenteTheme` (Composition
locals, ripple off, system bars following the theme), `AgenteText` (the ladder),
`AgenteIcon`, rows, chips, buttons, fields, sheets, the picker list, the tile
meter and mosaic, and the markdown renderer. Screens compose those and nothing
else — `DesignBoundaryTest` fails the build on any `androidx.compose.material`
import or any hex literal outside the generated token file. Material 3 is not a
dependency of the app.

Touch adaptations live in `AgenteMetrics.kt`, one value per line with its reason:
the desktop's 32dp row becomes 44dp, a 16dp glyph sits in a 40dp target. The
structure a phone forces is the other half: the activity rail and the sidebar
fold into one drawer (`ui/shell/AgenteDrawer.kt`) — spaces, then starting a
conversation, then the history, with settings pinned at the bottom where the rail
keeps its gear — and search is the desktop's modal (`ui/search/SearchModal.kt`):
field, then the results with the line that matched, an empty query listing recent
conversations. Counted nouns are generated from the desktop's `say` strings, so
`%1$d conversations` carries each locale's CLDR quantities.

## Current slice

- Home: the greeting over the mosaic and four starter cards (each glyph in its
  kind's hue), a drawer holding the spaces as a selector and the conversation
  list grouped by day, a search modal over titles and message bodies, a filled
  composer with the model pill inside it, and a transcript of bubbles for your own
  turns and prose for the answers — each answer with its reasoning folded above it
  and copy · regenerate · share below. Regenerate re-runs the turn from the same
  user message instead of stacking a second one.
- Roleplay: create/edit characters, raw name macros, opening messages, one-to-one
scenes (in the drawer with every other conversation) and independent cloud
replies using the same chat components.
- Sync foundation: transactionally journal local entity revisions in an outbox;
  shared Rust causal reducer preserves conflicts and tombstones and deduplicates
  delivery. The application does **not yet exchange data with Desktop**.
- Code: native landing destination, explicitly disconnected. Desktop pairing,
  authorization and reconnect are the next protocol milestone.

This is a development build. It does not yet include attachments, full desktop
Roleplay prompt/macro parity, lore/memory editing, push, or remote Code execution.
Roleplay resolves `{{char}}` / `{{user}}` at display/request time. Unavailable
desktop functionality is not simulated. Phone turns stop when backgrounded and
save incomplete replies; only completed replies enter future assistant history.

Known gaps, stated rather than hidden: the strings the desktop has no equivalent
for (the Code landing, the vault note, a few failure messages) are English-only
and marked `translatable="false"` in `res/values/strings.xml`.

The mockup asks for a few things the phone cannot honestly show yet, so they
are not in the UI at all rather than drawn dead:

| Not shown | Why |
| --- | --- |
| The attach (`+`) glyph in the composer | The phone cannot send a file yet |
| A reasoning chip beside the model | `agente-mobile`'s request takes no level; a chip that changes nothing is worse than none |
| Thumbs up/down on an answer | There is no feedback sink |
| Version navigation on regenerate (`‹ 2/4 ›`) | The schema has one message per answer; alternatives are a later feature |
| The Analyze starter | The landing shows four cards in a 2×2 grid, as the mockup does |

## Build

Requirements: JDK 17, Rust, Node 24 (for the generators), Android SDK platform 35
/ build-tools 35.0.0, Android NDK 28.2.13676358. Set `ANDROID_SDK_ROOT` (or
`ANDROID_HOME`), and optionally `ANDROID_NDK_HOME`. The Gradle wrapper pins Gradle
8.11.1.

```sh
rustup target add aarch64-linux-android x86_64-linux-android
cd apps/android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The default APK packages `arm64-v8a`. For an x86_64 emulator use
`-PagenteAbi=x86_64`. Gradle runs `scripts/build-rust.sh` before merging native
libraries. Output: `app/build/outputs/apk/debug/app-debug.apk`.

Install with `adb install -r app/build/outputs/apk/debug/app-debug.apk`. Choose a
provider, enter its key, load the available models, choose one and save. Provider
choices and request transport policy come from `agente-core` TOML specs rather
than an Android-only provider directory. This first adapter offers cloud specs
marked `offered`; arbitrary endpoints are not exposed.

```sh
# Host-only shared behavior tests
cargo test -p agente-mobile -p agente-sync
cargo clippy -p agente-mobile -p agente-sync --all-targets -- -D warnings

# With a running emulator/device matching the selected ABI
./gradlew :app:connectedDebugAndroidTest -PagenteAbi=x86_64
```

The instrumentation test checks the actual Room journal against the JNI sync
reducer. A physical-device run is still needed for keyboard/insets, TalkBack,
scrolling while streaming, background/process death, Keystore and live provider
requests. API keys are never embedded in an APK or supplied to test fixtures.

### Local toolchain

The SDK, JDK and Gradle home are environment-specific, so they stay in your shell
rather than in the repository:

```sh
export JAVA_HOME=<jdk-17>
export ANDROID_SDK_ROOT=<android-sdk>    # platform 35, build-tools 35.0.0, ndk 28.2.13676358
export GRADLE_USER_HOME=<gradle-home>    # wrapper distribution and dependency cache
cd apps/android && ./gradlew --no-daemon :app:assembleDebug
```

`gradle.properties` gives the Gradle JVM 2g and 768m of metaspace: the Kotlin
compiler runs in-process, and the previous 512m/256m ran out of metaspace once
the design system and its screens landed.

## Boundaries and next work

`agente-mobile` exposes cloud text completions, discovery and a metadata merge
function. It never creates a project runtime, process, tool registry, MCP manager
or subagent. It builds `agente-core` without its default `execution` feature, so
project tools, shell/process management, subagents and MCP transports are excluded
from the phone library. Desktop builds retain that feature by default. Desktop UI
files and global app state are not imported.

Cross-device sync requires a Desktop repository adapter, initial import, scoped
pairing grants, authenticated transfer, attachment manifests, conflict resolution
and canonical Home history continuation. The desktop's snapshot-save/prune path
must not receive stale remote snapshots. See the Android plan in `.agente/plans/`
for the agreed native Home / Roleplay / remote Code roadmap.

Fonts: Inter and IBM Plex Mono, both SIL Open Font License; licenses included in
`licenses/`. Glyphs are lucide (ISC), generated from the desktop's own package.
