FROM python:3.12-slim
# build-essential: triton compiles a small helper .so with the C compiler at first use
RUN apt-get update && apt-get install -y --no-install-recommends sox libsndfile1 curl build-essential && rm -rf /var/lib/apt/lists/*
# transformers 5.21 breaks the Qwen3-TTS tokenizer ("property 'upsample' ... has no setter"); 5.15.1 is what faster-qwen3-tts tests.
RUN pip install --no-cache-dir "faster-qwen3-tts==0.5.4" "transformers==5.15.1" soundfile lingua-language-detector fastapi "uvicorn[standard]"
WORKDIR /app
COPY server.py .
COPY voices /voices
ENV HF_HOME=/data/hf PYTHONUNBUFFERED=1
EXPOSE 8800
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8800", "--log-level", "warning"]
