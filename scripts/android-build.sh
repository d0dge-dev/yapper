#!/usr/bin/env bash
# Builds the debug APK of the Android app (mobile/). Needs the toolchain from scripts/android-toolchain.sh.
# Needs YAPPER_SERVER_URL (the https URL of your server; see mobile/capacitor.config.ts).
# Signed with your local ~/.android/debug.keystore: keep using the same keystore, or the phone refuses the update.
set -euo pipefail
: "${YAPPER_SERVER_URL:?set YAPPER_SERVER_URL to the https URL of your Yapper server, e.g. https://yapper.example.com/}"
cd "$(dirname "$0")/../mobile"

export JAVA_HOME="${JAVA_HOME:-$HOME/opt/jdk-21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/opt/android-sdk}"
export PATH="$JAVA_HOME/bin:$PATH"

# Some shells export npm_config_allow_scripts, which breaks npm ci; Capacitor needs no install scripts anyway.
[[ -d node_modules/@capacitor/android ]] || env -u npm_config_allow_scripts npm ci --ignore-scripts --no-audit --no-fund
env -u npm_config_allow_scripts npx cap sync android
(cd android && ./gradlew assembleDebug)

apk="$PWD/android/app/build/outputs/apk/debug/app-debug.apk"
echo "APK: $apk ($(du -h "$apk" | cut -f1))"
