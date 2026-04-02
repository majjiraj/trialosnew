"""Quick test of the new streaming extract_and_chunk_pdf."""
import sys, os, time, gc
sys.path.insert(0, '/app')
os.environ.update({
    'EMBEDDING_PROVIDER': 'ollama',
    'EMBEDDING_MODEL': 'nomic-embed-text',
    'EMBEDDING_DIM': '768',
    'OLLAMA_BASE_URL': 'http://host.docker.internal:11434',
})

import boto3, asyncio, tracemalloc

tracemalloc.start()

s3 = boto3.client('s3', endpoint_url='http://minio:9000',
                  aws_access_key_id='trialo', aws_secret_access_key='trialo_dev_secret')
obj = s3.get_object(
    Bucket='trialo-documents',
    Key='00000000-0000-0000-0000-000000000001/org-level/sdtm_ig/'
        'abf84ab0-75a4-45e8-a415-5efb3c99bbe7/SDTMIG v3.4-FINAL_2022-07-21.pdf')
content = obj['Body'].read()
del obj, s3
print(f'PDF size: {len(content):,} bytes', flush=True)

from document_processor import extract_and_chunk_pdf

async def run():
    t0 = time.time()
    chunks = await extract_and_chunk_pdf(content)
    elapsed = time.time() - t0
    cur, peak = tracemalloc.get_traced_memory()
    table_chunks = sum(1 for c in chunks if c.get('is_table'))
    print(f'Chunks: {len(chunks)} ({table_chunks} table, {len(chunks)-table_chunks} text)', flush=True)
    print(f'Time: {elapsed:.1f}s  Peak memory: {peak/1024/1024:.0f} MB', flush=True)

    # Show a sample table chunk
    for c in chunks:
        if c.get('is_table') and 'AETERM' in c['text']:
            print(f'\nSample AE table chunk (page {c["page"]}):')
            print(c['text'][:500])
            break

asyncio.run(run())
