FROM python:3.12-slim
WORKDIR /app
COPY requirements-base.txt .
RUN pip install --no-cache-dir -r requirements-base.txt semver==3.0.2
COPY marketplace/ .
EXPOSE 8005
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8005", "--workers", "2"]
