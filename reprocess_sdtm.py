"""
Standalone SDTM IG reprocessing script.
Run via: docker cp reprocess_sdtm.py trialo-ingestion-service-1:/tmp/ && docker exec trialo-ingestion-service-1 python3 /tmp/reprocess_sdtm.py
"""
import asyncio, sys, time
sys.path.insert(0, '/app')

import os
os.environ.setdefault('DATABASE_URL', 'postgresql://trialo:trialo_dev@postgres:5432/trialo')
os.environ.setdefault('S3_ENDPOINT', 'http://minio:9000')
os.environ.setdefault('S3_ACCESS_KEY', 'trialo')
os.environ.setdefault('S3_SECRET_KEY', 'trialo_dev_secret')
os.environ.setdefault('EMBEDDING_PROVIDER', 'ollama')
os.environ.setdefault('EMBEDDING_MODEL', 'nomic-embed-text')
os.environ.setdefault('EMBEDDING_DIM', '768')
os.environ.setdefault('OLLAMA_BASE_URL', 'http://host.docker.internal:11434')

import asyncpg
import boto3
from document_processor import extract_text, chunk_text
from embedding_client import EmbeddingClient

DOC_ID = 'abf84ab0-75a4-45e8-a415-5efb3c99bbe7'
ORG_ID = '00000000-0000-0000-0000-000000000001'
S3_BUCKET = 'trialo-documents'
S3_KEY = '00000000-0000-0000-0000-000000000001/org-level/sdtm_ig/abf84ab0-75a4-45e8-a415-5efb3c99bbe7/SDTMIG v3.4-FINAL_2022-07-21.pdf'


async def run():
    t_total = time.time()
    pool = await asyncpg.create_pool('postgresql://trialo:trialo_dev@postgres:5432/trialo')

    try:
        # 1. Set status processing
        async with pool.acquire() as conn:
            await conn.execute("UPDATE documents SET status='processing' WHERE id=$1", DOC_ID)
        print('[0] Status → processing', flush=True)

        # 2. Download PDF
        print('[1] Downloading from MinIO...', flush=True)
        s3 = boto3.client('s3', endpoint_url='http://minio:9000',
                          aws_access_key_id='trialo', aws_secret_access_key='trialo_dev_secret')
        obj = s3.get_object(Bucket=S3_BUCKET, Key=S3_KEY)
        content = obj['Body'].read()
        print(f'    Downloaded: {len(content):,} bytes', flush=True)

        # 3. Extract text (table-aware, PyMuPDF)
        print('[2] Extracting text (table-aware, PyMuPDF)...', flush=True)
        t0 = time.time()
        text = await extract_text(content, 'sdtm_ig')
        elapsed = time.time() - t0
        tables = text.count('| --- |')
        print(f'    Extracted: {len(text):,} chars, {tables} tables in {elapsed:.1f}s', flush=True)

        # Free PDF bytes before chunking to reduce peak memory
        del content
        import gc; gc.collect()

        # 4. Chunk
        print('[3] Chunking (section-aware)...', flush=True)
        t0 = time.time()
        chunks = chunk_text(text, 'sdtm_ig')
        elapsed = time.time() - t0
        table_chunks = sum(1 for c in chunks if c.get('is_table'))
        print(f'    {len(chunks)} chunks ({table_chunks} table, {len(chunks)-table_chunks} text) in {elapsed:.1f}s', flush=True)
        # Free extracted text — chunks hold the relevant slices
        del text; gc.collect()

        # 5. Delete old chunks + insert new
        print('[4] Replacing chunks in DB...', flush=True)
        t0 = time.time()
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM document_chunks WHERE document_id=$1", DOC_ID)
            for i, chunk in enumerate(chunks):
                await conn.execute(
                    "INSERT INTO document_chunks (document_id, org_id, study_id, chunk_index, page_number, section, content) "
                    "VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    DOC_ID, ORG_ID, None,
                    i, chunk.get('page'), chunk.get('section'), chunk['text']
                )
            count = await conn.fetchval("SELECT COUNT(*) FROM document_chunks WHERE document_id=$1", DOC_ID)
        print(f'    {count} chunks in DB in {time.time()-t0:.1f}s', flush=True)

        # 6. Embed in sequential batches (avoid overwhelming Ollama)
        print('[5] Embedding chunks (sequential batches of 10)...', flush=True)
        t0 = time.time()
        embedder = EmbeddingClient()
        BATCH = 10
        embedded = 0
        for batch_start in range(0, len(chunks), BATCH):
            batch_chunks = chunks[batch_start:batch_start + BATCH]
            texts = [c['text'] for c in batch_chunks]
            try:
                vectors = await embedder.embed(texts)
                vec_rows = [
                    ("[" + ",".join(str(x) for x in v) + "]", DOC_ID, batch_start + i)
                    for i, v in enumerate(vectors)
                ]
                async with pool.acquire() as conn:
                    await conn.executemany(
                        "UPDATE document_chunks SET embedding=$1::vector WHERE document_id=$2 AND chunk_index=$3",
                        vec_rows,
                    )
                embedded += len(batch_chunks)
            except Exception as e:
                print(f'    WARNING: batch {batch_start} failed: {e}', flush=True)
            if (batch_start // BATCH + 1) % 20 == 0:
                elapsed_so_far = time.time() - t0
                rate = embedded / elapsed_so_far if elapsed_so_far > 0 else 0
                eta = (len(chunks) - embedded) / rate if rate > 0 else 0
                print(f'    Progress: {embedded}/{len(chunks)} ({elapsed_so_far:.0f}s, ETA {eta:.0f}s)', flush=True)

        total_embedded = time.time() - t0
        print(f'    Embedded {embedded}/{len(chunks)} in {total_embedded:.0f}s', flush=True)

        # 7. Mark indexed
        async with pool.acquire() as conn:
            await conn.execute("UPDATE documents SET status='indexed', updated_at=NOW() WHERE id=$1", DOC_ID)
        print('[6] Status → indexed', flush=True)
        print(f'\nDone! Total: {time.time()-t_total:.0f}s', flush=True)

    except Exception as e:
        import traceback
        traceback.print_exc()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE documents SET status='error', error_message=$1, updated_at=NOW() WHERE id=$2",
                str(e), DOC_ID
            )
        print(f'FAILED: {e}', flush=True)
    finally:
        await pool.close()


asyncio.run(run())
