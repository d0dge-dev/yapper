FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
# CTranslate2 wants CUDA 12 cuBLAS/cuDNN; the pip wheels bring them, LD_LIBRARY_PATH points at them.
RUN pip install --no-cache-dir faster-whisper "av<16" nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" fastapi "uvicorn[standard]"
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY server.py .
EXPOSE 8801
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8801", "--log-level", "warning"]
