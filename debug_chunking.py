"""Debug script: count section matches and measure chunking memory."""
import sys, os, gc
sys.path.insert(0, '/app')
import boto3, re

os.environ['EMBEDDING_PROVIDER'] = 'ollama'
os.environ['EMBEDDING_MODEL'] = 'nomic-embed-text'
os.environ['EMBEDDING_DIM'] = '768'
os.environ['OLLAMA_BASE_URL'] = 'http://host.docker.internal:11434'

s3 = boto3.client('s3', endpoint_url='http://minio:9000',
                  aws_access_key_id='trialo', aws_secret_access_key='trialo_dev_secret')
obj = s3.get_object(Bucket='trialo-documents',
                    Key='00000000-0000-0000-0000-000000000001/org-level/sdtm_ig/'
                        'abf84ab0-75a4-45e8-a415-5efb3c99bbe7/SDTMIG v3.4-FINAL_2022-07-21.pdf')
content = obj['Body'].read()
del obj, s3
print(f'Downloaded: {len(content):,} bytes', flush=True)

from document_processor import _extract_pdf_sync
text = _extract_pdf_sync(content)
del content; gc.collect()
print(f'Extracted: {len(text):,} chars, {text.count(chr(10)):,} lines, {text.count("| --- |")} tables', flush=True)

# Analyze section pattern matches
section_pattern = re.compile(
    r'(?m)^('
    r'\d+(?:\.\d+)*\s+[A-Z][^\n]{2,80}'
    r'|SECTION\s+\d+[^\n]{0,60}'
    r'|[A-Z][A-Z ]{3,60}[A-Z]'
    r')$'
)
matches = list(section_pattern.finditer(text))
print(f'Section matches: {len(matches)}', flush=True)

# Analyze section sizes
last_end = 0
bodies = []
for m in matches:
    body = text[last_end:m.start()]
    bodies.append(len(body))
    last_end = m.end()
bodies.append(len(text[last_end:]))

import statistics
if bodies:
    print(f'Body sizes: min={min(bodies)}, max={max(bodies)}, avg={statistics.mean(bodies):.0f}, total={sum(bodies):,}', flush=True)
    large = [(bodies[i], matches[i-1].group(0)[:40] if i > 0 else 'Intro') for i in range(len(bodies)) if bodies[i] > 100000]
    print(f'Large bodies (>100K chars): {len(large)}', flush=True)
    for size, header in large[:5]:
        print(f'  {header!r}: {size:,} chars', flush=True)

# Show first 5 section headers
print('\nFirst 10 section headers:')
for m in matches[:10]:
    print(f'  {m.group(0)[:60]!r}', flush=True)

# Now time the chunk_text call
import time
print('\nRunning chunk_text...', flush=True)
t0 = time.time()
from document_processor import chunk_text
# Use sliding window (less memory intensive) for testing
from document_processor import _sliding_window_split
chunks = _sliding_window_split(text, 1200, 200)
print(f'Sliding window: {len(chunks)} chunks in {time.time()-t0:.1f}s', flush=True)
