# GPU text-to-speech for Yapper: Qwen3-TTS (Base, voice cloning) via faster-qwen3-tts on an NVIDIA GPU.
#   POST /v1/tts {"text": "...", "lang": "de"|"en"|"auto", "voice": "design-m"}  -> raw 16-bit mono PCM,
#        X-Sample-Rate / X-Lang / X-Voice headers. "auto" detects German vs English per request (lingua); without a
#        voice, the language's default voice is used (TTS_VOICE_DE / TTS_VOICE_EN), so English is spoken by an English voice.
#   POST /v1/tts/stream  same body; chunked 16-bit PCM while it is generated (~0.35 s to the first chunk, then ~0.67 s
#        of audio per chunk). Closing the connection stops generation.
#   GET  /health                                                         -> {"ok": true, "voices": [...], ...}
# Voices are reference clips in /voices/<name>.flac + <name>.txt (transcript). The model and the CUDA graphs live on
# one worker thread; requests queue behind each other (one GPU, sentences are short).
import asyncio, os, time, glob, logging, threading
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

MODEL = os.environ.get("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
LANG_VOICE = {"de": os.environ.get("TTS_VOICE_DE", "design-m"), "en": os.environ.get("TTS_VOICE_EN", "en-m")}
VOICE_DIR = os.environ.get("TTS_VOICE_DIR", "/voices")
LANGS = {"de": "German", "en": "English"}
MAX_CHARS = 800
CHUNK_STEPS = int(os.environ.get("TTS_CHUNK_STEPS", "8"))  # 12 Hz codec: 8 steps ≈ 0.67 s of audio per chunk
# Qwen3-TTS sometimes misses the end of a sentence and keeps babbling ("moaning", 79 chars -> 19 s on 2026-10-31).
# Normal speech is <= 0.07 s per char, digits get read out long, so cap the audio at 1.5 s + 0.085 s per char (digits x3).
CAP_BASE, CAP_PER_CHAR = 1.5, 0.085

log = logging.getLogger("tts")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
gpu = ThreadPoolExecutor(max_workers=1)
state: dict = {}


def load():
    from faster_qwen3_tts import FasterQwen3TTS
    t = time.time()
    model = FasterQwen3TTS.from_pretrained(MODEL)
    voices = {}
    for f in sorted(glob.glob(f"{VOICE_DIR}/*.flac")):
        name = os.path.basename(f)[:-5]
        voices[name] = (f, open(f[:-5] + ".txt").read().strip())
    missing = [v for v in LANG_VOICE.values() if v not in voices]
    if missing:
        raise SystemExit(f"default voices {missing} not in {sorted(voices)}")
    from lingua import Language, LanguageDetectorBuilder
    state["detector"] = LanguageDetectorBuilder.from_languages(Language.GERMAN, Language.ENGLISH).build()
    # First call per voice captures the CUDA graphs and caches the clone prompt.
    for name, (ref, txt) in voices.items():
        model.generate_voice_clone(text="Kurzer Test.", language="German", ref_audio=ref, ref_text=txt)
        model.generate_voice_clone(text="Quick test.", language="English", ref_audio=ref, ref_text=txt)
    for _ in model.generate_voice_clone_streaming(text="Kurzer Test.", language="German", ref_audio=ref, ref_text=txt,
                                                  chunk_size=CHUNK_STEPS):
        pass
    state.update(model=model, voices=voices)
    log.info("loaded %s, voices %s in %.0f s", MODEL, sorted(voices), time.time() - t)


def cap_seconds(text: str) -> float:
    return CAP_BASE + CAP_PER_CHAR * (len(text) + 2 * sum(c.isdigit() for c in text))


def check_cap(text: str, lang: str, voice: str, seconds: float) -> None:
    if seconds >= cap_seconds(text) - 0.5:
        log.warning("%s/%s hit the length cap (%.1f s, runaway?): %r", voice, lang, seconds, text)


def synth(text: str, lang: str, voice: str):
    ref, txt = state["voices"][voice]
    wavs, sr = state["model"].generate_voice_clone(text=text, language=LANGS[lang], ref_audio=ref, ref_text=txt,
                                                   max_new_tokens=int(cap_seconds(text) * 12))
    audio = np.asarray(wavs[0], dtype=np.float32).squeeze()
    check_cap(text, lang, voice, len(audio) / sr)
    return audio, sr


def to_pcm(audio) -> bytes:
    return (np.clip(np.asarray(audio, dtype=np.float32).squeeze(), -1, 1) * 32767).astype("<i2").tobytes()


def stream_job(text: str, lang: str, voice: str, put, stop: threading.Event):
    ref, txt = state["voices"][voice]
    t, n, first = time.time(), 0, None
    try:
        for chunk, sr, _ in state["model"].generate_voice_clone_streaming(
                text=text, language=LANGS[lang], ref_audio=ref, ref_text=txt, chunk_size=CHUNK_STEPS,
                max_new_tokens=int(cap_seconds(text) * 12)):
            if stop.is_set():
                break
            first = first or time.time() - t
            n += len(np.asarray(chunk).squeeze())
            put(to_pcm(chunk))
        log.info("%s/%s %d chars -> %.1f s audio streamed, first chunk %.2f s, done %.2f s%s", voice, lang, len(text),
                 n / 24000, first or 0, time.time() - t, " (cancelled)" if stop.is_set() else "")
        check_cap(text, lang, voice, n / 24000)
    except Exception as e:  # surfaces as a cut-off stream; the client falls back or stops the sentence
        log.exception("stream failed: %s", e)
    finally:
        put(None)


def detect(text: str) -> str:
    from lingua import Language
    # Short German sentences full of English tech terms still come out German; only clearly English text flips.
    return "en" if state["detector"].detect_language_of(text) == Language.ENGLISH else "de"


app = FastAPI()


@app.on_event("startup")
async def startup():
    await asyncio.get_running_loop().run_in_executor(gpu, load)


class Req(BaseModel):
    text: str
    lang: str = "auto"
    voice: str | None = None


def resolve(r: Req):
    text = r.text.strip()
    if not text or len(text) > MAX_CHARS:
        raise HTTPException(400, f"text must be 1..{MAX_CHARS} chars")
    lang = detect(text) if r.lang == "auto" else r.lang
    if lang not in LANGS:
        raise HTTPException(400, f"lang must be one of {sorted(LANGS)} or auto")
    voice = r.voice or LANG_VOICE[lang]
    if voice not in state["voices"]:
        raise HTTPException(400, f"unknown voice {voice!r}, have {sorted(state['voices'])}")
    return text, lang, voice


@app.post("/v1/tts/stream")
async def tts_stream(r: Req):
    text, lang, voice = resolve(r)
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()
    loop.run_in_executor(gpu, stream_job, text, lang, voice, lambda b: loop.call_soon_threadsafe(q.put_nowait, b), stop)

    async def body():
        try:
            while (b := await q.get()) is not None:
                yield b
        finally:
            stop.set()  # client went away: the worker stops after the current step

    return StreamingResponse(body(), media_type="audio/L16",
                             headers={"X-Sample-Rate": "24000", "X-Lang": lang, "X-Voice": voice})


@app.post("/v1/tts")
async def tts(r: Req):
    text, lang, voice = resolve(r)
    t = time.time()
    audio, sr = await asyncio.get_running_loop().run_in_executor(gpu, synth, text, lang, voice)
    pcm = to_pcm(audio)
    log.info("%s/%s %d chars -> %.1f s audio in %.2f s", voice, lang, len(text), len(audio) / sr, time.time() - t)
    return Response(pcm, media_type="audio/L16", headers={"X-Sample-Rate": str(sr), "X-Lang": lang, "X-Voice": voice})


@app.get("/health")
async def health():
    if "model" not in state:
        raise HTTPException(503, "loading")
    return {"ok": True, "model": MODEL, "voice_by_lang": LANG_VOICE, "voices": sorted(state["voices"])}
