FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi==0.111.0 \
    uvicorn[standard]==0.30.0 \
    asyncpg==0.29.0 \
    pydantic==2.7.1 \
    pydantic-settings==2.3.0 \
    httpx==0.27.0 \
    structlog==24.2.0 \
    aiokafka==0.10.0 \
    "redis[asyncio]==5.0.4" \
    pyzeebe==4.3.0

COPY embedding_client.py /app/
COPY super-agent/ /app/

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8015"]
