# GPU speech services (optional)

Two small HTTP services that give Yapper better recognition and a more natural voice than the CPU defaults
(Parakeet + Piper). Each one is a single FastAPI script in a Docker image. They need an NVIDIA GPU with the
NVIDIA container toolkit. Both together use about 6.5 GB VRAM (TTS ~5 GB, ASR ~1.2 GB with int8), so they fit
on one 8 GB card.

| Service | Model | Port | Yapper settings |
|---|---|---|---|
| `asr/` | Whisper large-v3-turbo (faster-whisper, int8) | 8801 | `YAP_ASR=gpu`, `YAP_GPU_ASR_URL` |
| `tts/` | Qwen3-TTS-12Hz-1.7B-Base via [faster-qwen3-tts](https://pypi.org/project/faster-qwen3-tts/) | 8800 | `YAP_TTS=gpu`, `YAP_GPU_TTS_URL` |

```bash
cd gpu-services/asr && docker compose up -d --build
cd ../tts && docker compose up -d --build
curl -s http://localhost:8801/health; curl -s http://localhost:8800/health   # 503 while models load (minutes on first start)
```

Yapper falls back to the CPU engines per segment or sentence if a service errors or times out, so these can be
down without breaking calls. Neither service has authentication. Run them on a trusted network, or on the same
host bound to 127.0.0.1. Only text (TTS) or the caller's audio (ASR) is sent to them.

On measured hardware (RTX 3070): ASR ≈ 0.35 s per sentence; TTS ≈ 0.4× real time, first streamed audio after
≈ 0.35–0.4 s.

## HTTP contract

You can replace either service with your own as long as it speaks this.

### ASR

`POST /v1/asr?lang=auto|de|en`
- Body: raw 16-bit little-endian mono PCM at 16 kHz (`Content-Type: application/octet-stream`), at least 0.1 s.
  Yapper sends one VAD-cut utterance per request.
- Response: `{"text": "…", "lang": "de", "ms": 312}`. `lang=auto` picks the likelier of German and English.
- `GET /health` → 200 `{"ok": true, …}` once loaded, 503 while loading.

### TTS

`POST /v1/tts` with JSON `{"text": "…", "lang": "de" | "en" | "auto", "voice": "<name>"?}`
- `text`: 1–800 characters (Yapper sends one sentence at a time).
- `lang: "auto"` detects German vs English per request, and without `voice` uses that language's default voice.
- Response: raw 16-bit little-endian mono PCM (`audio/L16`), headers `X-Sample-Rate` (24000), `X-Lang`, `X-Voice`.

`POST /v1/tts/stream`: same body. The response is chunked PCM as it is generated. Yapper starts playing the first
chunk right away. Closing the connection (barge-in) stops generation.

`GET /health` → `{"ok": true, "model": …, "voice_by_lang": {…}, "voices": [...]}`, 503 while loading.

## Voices

The TTS clones a voice from a short reference clip. The bundled ones are synthetic (designed with
Qwen3-TTS VoiceDesign), see [`tts/voices/README.md`](tts/voices/README.md), which also explains how to make your own.
