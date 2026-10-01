#!/usr/bin/env bash
# package-code-deb.sh BINARY amd64|arm64 VERSION OUTPUT.deb
set -euo pipefail
binary=$(realpath "$1")
arch=$2
version=$3
output=$(realpath -m "$4")
project=$(cd "$(dirname "$0")/.." && pwd)
case "$arch" in
  amd64) machine='Advanced Micro Devices X86-64' ;;
  arm64) machine='AArch64' ;;
  *) echo "Unsupported Debian architecture: $arch" >&2; exit 1 ;;
esac
readelf -h "$binary" | grep -q "$machine"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage="$work/package"
mkdir -p "$stage/DEBIAN" "$stage/usr/bin" "$stage/usr/share/applications" "$stage/usr/share/doc/agente-code" "$work/debian"
install -m755 "$binary" "$stage/usr/bin/agente"
install -m644 "$project/packaging/linux/agente-code.desktop" "$stage/usr/share/applications/"
install -m644 "$project/LICENSE" "$stage/usr/share/doc/agente-code/copyright"
for size in 16 32 48 64 128 256 512; do
  directory="$stage/usr/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$directory"
  install -m644 "$project/assets/brand/agente-code-icon-${size}.png" "$directory/agente-code.png"
done
mkdir -p "$stage/usr/share/icons/hicolor/scalable/apps"
install -m644 "$project/assets/brand/agente-code-icon.svg" "$stage/usr/share/icons/hicolor/scalable/apps/agente-code.svg"
cat > "$work/debian/control" <<CONTROL
Source: agente-code
Section: devel
Priority: optional
Maintainer: Agente Contributors <48396639+fabricio3g@users.noreply.github.com>

Package: agente-code
Architecture: $arch
Description: Keyboard-first terminal coding agent
CONTROL
dependencies=$(cd "$work" && dpkg-shlibdeps -O -e"$stage/usr/bin/agente")
dependencies=${dependencies#shlibs:Depends=}
cat > "$stage/DEBIAN/control" <<CONTROL
Package: agente-code
Version: $version
Architecture: $arch
Section: devel
Priority: optional
Maintainer: Agente Contributors <48396639+fabricio3g@users.noreply.github.com>
Installed-Size: $(du -sk "$stage/usr" | cut -f1)
Depends: $dependencies
Description: Agente Code terminal coding agent
 Keyboard-first Rust coding agent with a minimal terminal interface.
CONTROL
mkdir -p "$(dirname "$output")"
dpkg-deb --root-owner-group --build "$stage" "$output"
dpkg-deb --info "$output"
dpkg-deb --contents "$output"
