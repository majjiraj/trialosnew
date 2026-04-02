FROM python:3.12-slim

# System deps for OCR and document processing
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-base.txt .
RUN pip install --no-cache-dir -r requirements-base.txt \
    pdfplumber==0.11.0 \
    pytesseract==0.3.10 \
    pdf2image==1.17.0 \
    python-docx==1.1.0 \
    openpyxl==3.1.3 \
    pillow==10.3.0

COPY embedding_client.py .
COPY ingestion/ .
EXPOSE 8003
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003", "--workers", "2"]
