#!/usr/bin/env bash
# Downloads the local speech models into $YAP_MODELS (default ./models, gitignored). ~850 MB.
# ASR: NVIDIA Parakeet TDT 0.6B v3 (25 European languages incl. German/English), int8, CPU.
# VAD: Silero. TTS: Piper voices (Thorsten for German, Lessac for English).
set -euo pipefail
cd "$(dirname "$0")/.."
dest="${YAP_MODELS:-models}"
mkdir -p "$dest" && cd "$dest"
B=https://github.com/k2-fsa/sherpa-onnx/releases/download
fetch_tar() { [ -d "$1" ] || { echo "fetching $1"; curl -fsSL "$B/$2/$1.tar.bz2" | tar xjf -; }; }
[ -f silero_vad.onnx ] || curl -fsSLO "$B/asr-models/silero_vad.onnx"
fetch_tar sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 asr-models
fetch_tar vits-piper-de_DE-thorsten-high tts-models
fetch_tar vits-piper-en_US-lessac-medium tts-models
echo "models ready:"; du -sh -- */ silero_vad.onnx
