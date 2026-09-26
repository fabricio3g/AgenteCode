#!/usr/bin/env sh
# Install the Agente Code launcher + icons for the current user (no root).
# Run from the repository root after `cargo install --path crates/agente-cli`
# (or with `agente` otherwise on PATH).
set -eu

data="${XDG_DATA_HOME:-$HOME/.local/share}"
for size in 16 32 48 64 128 256 512; do
    dir="$data/icons/hicolor/${size}x${size}/apps"
    mkdir -p "$dir"
    cp "assets/brand/agente-code-icon-${size}.png" "$dir/agente-code.png"
done
mkdir -p "$data/icons/hicolor/scalable/apps" "$data/applications"
cp assets/brand/agente-code-icon.svg "$data/icons/hicolor/scalable/apps/agente-code.svg"
cp packaging/linux/agente-code.desktop "$data/applications/agente-code.desktop"

command -v gtk-update-icon-cache >/dev/null 2>&1 \
    && gtk-update-icon-cache -q "$data/icons/hicolor" 2>/dev/null || true
command -v update-desktop-database >/dev/null 2>&1 \
    && update-desktop-database -q "$data/applications" 2>/dev/null || true
echo "Installed Agente Code launcher to $data/applications"
