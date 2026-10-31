# GPU speech recognition for Yapper: Whisper (faster-whisper / CTranslate2) on an NVIDIA GPU.
#   POST /v1/asr?lang=auto|de|en   body: raw 16-bit mono PCM at 16 kHz   -> {"text", "lang", "ms"}
#   GET  /health
# "auto" picks the likelier of German and English (Yapper calls are one or the other). Yapper has already cut the
# audio with its VAD, so no VAD here; known Whisper hallucinations on noise ("Untertitel …") are dropped.
import asyncio, os, re, time, logging
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from fastapi import FastAPI, HTTPException, Request

MODEL = os.environ.get("ASR_MODEL", "large-v3-turbo")
PROMPT = os.environ.get("ASR_PROMPT", "")
LANGS = ("de", "en")
HALLUCINATIONS = re.compile(r"untertitel|amara\.org|vielen dank für(s| das) zu(schauen|hören)|thanks? for watching|"
                            r"subtitles by|copyright|swr \d|zdf", re.I)

log = logging.getLogger("asr")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
gpu = ThreadPoolExecutor(max_workers=1)
state: dict = {}


def load():
    from faster_whisper import WhisperModel
    t = time.time()
    m = WhisperModel(MODEL, device="cuda", compute_type=os.environ.get("ASR_COMPUTE", "int8_float16"), download_root="/data/models")
    m.transcribe(np.zeros(16000, dtype=np.float32), language="de")
    state["model"] = m
    log.info("loaded %s in %.0f s", MODEL, time.time() - t)


def run(audio: np.ndarray, lang: str):
    m = state["model"]
    if lang == "auto":
        _, _, probs = m.detect_language(audio)
        p = dict(probs)
        lang = max(LANGS, key=lambda l: p.get(l, 0.0))
    segs, _ = m.transcribe(audio, language=lang, beam_size=5, vad_filter=False, condition_on_previous_text=False,
                           without_timestamps=True, initial_prompt=PROMPT or None)
    keep = [s.text for s in segs if not (s.no_speech_prob > 0.6 and s.avg_logprob < -1.0)]
    text = " ".join(t.strip() for t in keep).strip()
    if HALLUCINATIONS.search(text):
        text = ""
    return text, lang


app = FastAPI()


@app.on_event("startup")
async def startup():
    await asyncio.get_running_loop().run_in_executor(gpu, load)


@app.post("/v1/asr")
async def asr(req: Request, lang: str = "auto"):
    if lang not in (*LANGS, "auto"):
        raise HTTPException(400, "lang must be de, en or auto")
    body = await req.body()
    if len(body) < 3200 or len(body) % 2:
        raise HTTPException(400, "body must be 16-bit PCM, 16 kHz mono, at least 0.1 s")
    audio = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768
    t = time.time()
    text, lang = await asyncio.get_running_loop().run_in_executor(gpu, run, audio, lang)
    ms = int((time.time() - t) * 1000)
    log.info("%.1f s %s -> %d chars in %d ms", len(audio) / 16000, lang, len(text), ms)
    return {"text": text, "lang": lang, "ms": ms}


@app.get("/health")
async def health():
    if "model" not in state:
        raise HTTPException(503, "loading")
    return {"ok": True, "model": MODEL}
