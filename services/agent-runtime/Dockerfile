FROM python:3.12-slim
WORKDIR /app
COPY requirements-base.txt .
RUN pip install --no-cache-dir -r requirements-base.txt
COPY embedding_client.py .
COPY agent-runtime/ .
EXPOSE 8004
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8004", "--workers", "2"]
