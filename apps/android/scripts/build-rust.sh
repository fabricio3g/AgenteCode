#!/usr/bin/env bash
set -euo pipefail
agente_abi="${1:-arm64-v8a}"
agente_output="${2:?JNI output directory required}"
agente_root="$(cd "$(dirname "$0")/../../.." && pwd)"
agente_ndk="${ANDROID_NDK_HOME:-${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}/ndk/28.2.13676358}"
case "$(uname -s)" in
    Linux) agente_host=linux-x86_64 ;;
    Darwin) agente_host=darwin-x86_64 ;;
    *) echo "Build native libraries with Linux, macOS, or WSL." >&2; exit 1 ;;
esac
case "$agente_abi" in
    arm64-v8a) agente_target=aarch64-linux-android; agente_cc=aarch64-linux-android26-clang ;;
    x86_64) agente_target=x86_64-linux-android; agente_cc=x86_64-linux-android26-clang ;;
    *) echo "Supported ABIs: arm64-v8a, x86_64" >&2; exit 1 ;;
esac
agente_toolchain="$agente_ndk/toolchains/llvm/prebuilt/$agente_host/bin"
test -x "$agente_toolchain/$agente_cc" || { echo "Install Android NDK 28.2.13676358 and set ANDROID_SDK_ROOT." >&2; exit 1; }
agente_linker_var="CARGO_TARGET_$(printf '%s' "$agente_target" | tr '[:lower:]-' '[:upper:]_')_LINKER"
agente_cc_var="CC_${agente_target//-/_}"
agente_ar_var="AR_${agente_target//-/_}"
env "$agente_linker_var=$agente_toolchain/$agente_cc" \
    "$agente_cc_var=$agente_toolchain/$agente_cc" \
    "$agente_ar_var=$agente_toolchain/llvm-ar" \
    CARGO_TARGET_DIR="$agente_root/target/android" \
    cargo build --manifest-path "$agente_root/Cargo.toml" --locked --release --jobs "${AGENTE_BUILD_JOBS:-1}" -p agente-mobile --target "$agente_target"
mkdir -p "$agente_output/$agente_abi"
cp "$agente_root/target/android/$agente_target/release/libagente_mobile.so" "$agente_output/$agente_abi/"
