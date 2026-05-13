# Build stage: clone repo and install slim dependencies
FROM python:3.12-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone the upstream repo
RUN git clone --depth=1 https://github.com/siddharthchauhan/protocol-to-USDM .

# Overlay our slim requirements (skips unstructured/liteparse → no PyTorch/CUDA/Node)
COPY requirements-api.txt ./requirements-api.txt

# Install pip deps
RUN pip install --no-cache-dir --default-timeout=600 --prefix=/install -r requirements-api.txt

# Patch: swap liteparse_plus_vision → markitdown in DEFAULT_PARSER_OUTPUTS.
# markitdown is already a supported tag in _ensure_markdown and is installed
# via requirements-api.txt — no Node.js dependency required.
RUN sed -i \
    's|"liteparse_plus_vision": ROOT / "outputs" / "liteparse_plus_vision.md"|"markitdown": ROOT / "outputs" / "markitdown.md"|g' \
    run_v3.py

# Runtime stage
FROM python:3.12-slim

WORKDIR /app

COPY --from=builder /install /usr/local
COPY --from=builder /app /app

# Job artifacts directory
RUN mkdir -p /app/jobs

ENV USDM_JOBS_DIR=/app/jobs \
    USDM_API_KEY=trialo-internal \
    PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
