#!/usr/bin/env bash
# Installs the Android build toolchain in user space (no sudo), idempotently:
#   JDK (Temurin 21) -> ~/opt/jdk-21
#   Android SDK      -> ~/opt/android-sdk (cmdline-tools, platform-tools, platform, build-tools)
# Re-running only fetches what is missing. Prints the env lines to put in ~/.bashrc at the end.
# Versions are pinned; bump them here (and in README "Android app") together.
set -euo pipefail

JDK_VERSION="21.0.12.1+1"          # Temurin release tag without the "jdk-" prefix
CMDLINE_TOOLS_BUILD="16111833"     # commandlinetools-linux-<build>_latest.zip
ANDROID_PLATFORM="android-36"      # = compileSdk / targetSdk in mobile/android/variables.gradle
BUILD_TOOLS="36.0.0"

OPT="${OPT:-$HOME/opt}"
JDK_DIR="$OPT/jdk-21"
SDK_DIR="${ANDROID_HOME:-$OPT/android-sdk}"
mkdir -p "$OPT"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ---- JDK
if [[ -x "$JDK_DIR/bin/java" ]] && "$JDK_DIR/bin/java" -version 2>&1 | grep -q "${JDK_VERSION%%+*}"; then
  echo "jdk: $JDK_VERSION already in $JDK_DIR"
else
  tag="jdk-${JDK_VERSION}"
  file="OpenJDK21U-jdk_x64_linux_hotspot_${JDK_VERSION/+/_}.tar.gz"
  url="https://github.com/adoptium/temurin21-binaries/releases/download/${tag/+/%2B}/$file"
  echo "jdk: downloading $url"
  curl -fL --retry 3 -o "$tmp/$file" "$url"
  curl -fsSL -o "$tmp/$file.sha256.txt" "$url.sha256.txt"
  (cd "$tmp" && sha256sum -c "$file.sha256.txt")
  mkdir -p "$tmp/jdk" && tar -xzf "$tmp/$file" -C "$tmp/jdk" --strip-components=1
  rm -rf "$JDK_DIR" && mv "$tmp/jdk" "$JDK_DIR"
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"

# ---- Android command-line tools
SDKMANAGER="$SDK_DIR/cmdline-tools/latest/bin/sdkmanager"
if [[ -x "$SDKMANAGER" ]]; then
  echo "cmdline-tools: already in $SDK_DIR/cmdline-tools/latest"
else
  zip="commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip"
  echo "cmdline-tools: downloading $zip"
  curl -fL --retry 3 -o "$tmp/$zip" "https://dl.google.com/android/repository/$zip"
  mkdir -p "$tmp/clt" "$SDK_DIR/cmdline-tools"
  (cd "$tmp/clt" && python3 -I -m zipfile -e "$tmp/$zip" .)
  chmod +x "$tmp/clt/cmdline-tools/bin/"*
  rm -rf "$SDK_DIR/cmdline-tools/latest" && mv "$tmp/clt/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
fi

# ---- SDK packages (sdkmanager skips installed ones)
export ANDROID_HOME="$SDK_DIR"
yes | "$SDKMANAGER" --sdk_root="$SDK_DIR" --licenses >/dev/null || true
"$SDKMANAGER" --sdk_root="$SDK_DIR" --install "platform-tools" "platforms;$ANDROID_PLATFORM" "build-tools;$BUILD_TOOLS"

echo
echo "Toolchain ready. Add to ~/.bashrc (or export before building):"
echo "  export JAVA_HOME=\"$JDK_DIR\""
echo "  export ANDROID_HOME=\"$SDK_DIR\""
echo "  export PATH=\"\$JAVA_HOME/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/cmdline-tools/latest/bin:\$PATH\""
java -version 2>&1 | head -1
"$SDKMANAGER" --sdk_root="$SDK_DIR" --list_installed 2>/dev/null | grep -E "build-tools|platforms|platform-tools|cmdline" || true
