#!/bin/sh
# Install Agente on Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/fabricio3g/AgenteCode/main/install.sh | sh
#
# Installs Agente Code (the `agente` command) into ~/.local/bin. Options:
#   --desktop          install Agente Desktop too (AppImage + app menu entry)
#   --desktop-only     install only Agente Desktop
#   --version vX.Y.Z   a specific release instead of the latest
#   --dir PATH         where to put `agente` (default ~/.local/bin)
#
# With piping, pass options after `sh -s --`, e.g. `| sh -s -- --desktop`.
# AGENTE_REPO overrides the GitHub repository (owner/name).
set -eu

REPO="${AGENTE_REPO:-fabricio3g/AgenteCode}"
BIN_DIR="${HOME}/.local/bin"
VERSION=""
WANT_CLI=1
WANT_DESKTOP=0

say() { printf '%s\n' "$*"; }
fail() { printf 'agente install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs '$1' — install it and run this again"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --desktop) WANT_DESKTOP=1 ;;
        --desktop-only) WANT_DESKTOP=1; WANT_CLI=0 ;;
        --version) shift; VERSION="${1:-}" ;;
        --dir) shift; BIN_DIR="${1:-}" ;;
        -h|--help) sed -n '2,14p' "$0" 2>/dev/null || true; exit 0 ;;
        *) fail "unknown option: $1" ;;
    esac
    shift
done

[ "$(uname -s)" = "Linux" ] || fail "this script is for Linux; on Windows use install.ps1 (see the README)"
need curl
need tar
need uname

case "$(uname -m)" in
    x86_64|amd64) TARGET="x86_64-unknown-linux-gnu"; DESKTOP_ARCH="x86_64" ;;
    aarch64|arm64) TARGET="aarch64-unknown-linux-gnu"; DESKTOP_ARCH="arm64" ;;
    *) fail "unsupported CPU: $(uname -m) (x86_64 and arm64 are available)" ;;
esac

if [ -z "$VERSION" ]; then
    # /releases/latest redirects to /releases/tag/<version>.
    VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's#.*/##')
    case "$VERSION" in v*) ;; *) fail "could not find the latest release of $REPO" ;; esac
fi
BASE="https://github.com/$REPO/releases/download/$VERSION"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

sha256_ok() {
    # $1 file, $2 expected hash
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$1" | cut -d' ' -f1)
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$1" | cut -d' ' -f1)
    else
        say "  (no sha256sum found: skipping the checksum)"
        return 0
    fi
    [ "$actual" = "$2" ]
}

install_cli() {
    name="agente-$VERSION-$TARGET"
    say "Downloading Agente Code $VERSION ($TARGET)…"
    curl -fsSL "$BASE/$name.tar.gz" -o "$TMP/$name.tar.gz" || fail "download failed: $BASE/$name.tar.gz"
    curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" || fail "could not download the checksums"
    expected=$(grep " $name.tar.gz\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)
    [ -n "$expected" ] || fail "no checksum for $name.tar.gz"
    sha256_ok "$TMP/$name.tar.gz" "$expected" || fail "checksum mismatch for $name.tar.gz"
    tar -xzf "$TMP/$name.tar.gz" -C "$TMP"
    mkdir -p "$BIN_DIR"
    install -m 0755 "$TMP/$name/agente" "$BIN_DIR/agente"
    say "Installed agente to $BIN_DIR/agente"
    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *) say "Add it to your PATH:  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile" ;;
    esac
}

install_desktop() {
    [ "$DESKTOP_ARCH" = "x86_64" ] || fail "Agente Desktop is built for x86_64 only for now; Agente Code works on arm64"
    number="${VERSION#v}"
    file="Agente-$number-$DESKTOP_ARCH.AppImage"
    apps="${XDG_DATA_HOME:-$HOME/.local/share}"
    dest="$apps/agente/Agente.AppImage"
    say "Downloading Agente Desktop $VERSION…"
    mkdir -p "$apps/agente" "$apps/applications"
    curl -fSL --progress-bar "$BASE/$file" -o "$TMP/$file" || fail "download failed: $BASE/$file"
    install -m 0755 "$TMP/$file" "$dest"
    cat > "$apps/applications/agente-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Agente
Comment=Local AI workspace: chat, models, artifacts and code
Exec="$dest" %U
Icon=agente-desktop
Terminal=false
Categories=Development;Utility;
StartupWMClass=Agente
EOF
    icon_dir="$apps/icons/hicolor/512x512/apps"
    mkdir -p "$icon_dir"
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$VERSION/assets/brand/agente-code-icon-512.png" -o "$icon_dir/agente-desktop.png" 2>/dev/null || true
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$apps/applications" 2>/dev/null || true
    say "Installed Agente Desktop to $dest (look for 'Agente' in your app menu)"
    if ! ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
        say "Note: AppImages need FUSE 2. On Ubuntu/Debian: sudo apt install libfuse2t64 (or libfuse2)"
    fi
}

[ "$WANT_CLI" = 1 ] && install_cli
[ "$WANT_DESKTOP" = 1 ] && install_desktop
say "Done."
