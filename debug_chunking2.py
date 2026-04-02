"""Debug v2: test section counts and chunking after fixes."""
import sys, os, gc, time
sys.path.insert(0, '/app')
import boto3, re

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
print(f'Extracted: {len(text):,} chars', flush=True)

# Count section matches with new regex
section_pattern = re.compile(
    r'(?m)^('
    r'\d+(?:\.\d+){0,2}\s+[A-Z][A-Za-z][^\n]{5,78}'
    r'|SECTION\s+\d+[^\n]{0,60}'
    r'|[A-Z]{2}[A-Z ]{2,58}[A-Z]{2}'
    r')$'
)
matches = list(section_pattern.finditer(text))
print(f'Section matches (fixed): {len(matches)}', flush=True)
if matches:
    print('First 5 sections:')
    for m in matches[:5]:
        print(f'  {m.group(0)[:60]!r}', flush=True)

# Now run chunk_text
print('\nRunning chunk_text(sdtm_ig)...', flush=True)
import tracemalloc
tracemalloc.start()
t0 = time.time()
from document_processor import chunk_text
chunks = chunk_text(text, 'sdtm_ig')
elapsed = time.time() - t0
cur, peak = tracemalloc.get_traced_memory()
print(f'Done: {len(chunks)} chunks in {elapsed:.1f}s, peak={peak/1024/1024:.0f}MB', flush=True)
table_chunks = sum(1 for c in chunks if c.get('is_table'))
print(f'  Table chunks: {table_chunks}, Text chunks: {len(chunks)-table_chunks}', flush=True)

# Sample some table chunks
print('\nSample table chunk:')
for c in chunks:
    if c.get('is_table') and '|' in c['text']:
        print(c['text'][:400])
        break
