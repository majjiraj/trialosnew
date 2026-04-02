"""
SDTM IG reprocessing script — runs on Mac host, connects to Docker services via localhost.
Uses locally-installed pymupdf (not in Docker), connects to postgres:5432 and minio:9000.
"""
import asyncio, sys, time, gc
sys.path.insert(0, '/Users/rajeshmajji/trialo/services/ingestion')
sys.path.insert(0, '/Users/rajeshmajji/trialo/services')

import os
os.environ['EMBEDDING_PROVIDER'] = 'ollama'
os.environ['EMBEDDING_MODEL'] = 'nomic-embed-text'
os.environ['EMBEDDING_DIM'] = '768'
os.environ['OLLAMA_BASE_URL'] = 'http://localhost:11434'

import asyncpg
import boto3
from document_processor import extract_text, chunk_text
from embedding_client import EmbeddingClient

DOC_ID = 'abf84ab0-75a4-45e8-a415-5efb3c99bbe7'
ORG_ID = '00000000-0000-0000-0000-000000000001'
PG_DSN = 'postgresql://trialo:trialo_dev@localhost:5432/trialo'
S3_ENDPOINT = 'http://localhost:9000'
S3_BUCKET = 'trialo-documents'
S3_KEY = '00000000-0000-0000-0000-000000000001/org-level/sdtm_ig/abf84ab0-75a4-45e8-a415-5efb3c99bbe7/SDTMIG v3.4-FINAL_2022-07-21.pdf'


async def run():
    t_total = time.time()
    pool = await asyncpg.create_pool(PG_DSN)

    try:
        async with pool.acquire() as conn:
            await conn.execute("UPDATE documents SET status='processing' WHERE id=$1", DOC_ID)
        print('[0] Status → processing', flush=True)

        print('[1] Downloading from MinIO...', flush=True)
        s3 = boto3.client('s3', endpoint_url=S3_ENDPOINT,
                          aws_access_key_id='trialo', aws_secret_access_key='trialo_dev_secret')
        obj = s3.get_object(Bucket=S3_BUCKET, Key=S3_KEY)
        content = obj['Body'].read()
        print(f'    Downloaded: {len(content):,} bytes', flush=True)

        print('[2] Extracting text (table-aware, PyMuPDF)...', flush=True)
        t0 = time.time()
        text = await extract_text(content, 'sdtm_ig')
        print(f'    {len(text):,} chars, {text.count("| --- |")} tables in {time.time()-t0:.1f}s', flush=True)
        del content; gc.collect()

        print('[3] Chunking...', flush=True)
        t0 = time.time()
        chunks = chunk_text(text, 'sdtm_ig')
        print(f'    {len(chunks)} chunks ({sum(1 for c in chunks if c.get("is_table"))} table) in {time.time()-t0:.1f}s', flush=True)
        del text; gc.collect()

        print('[4] Inserting chunks into DB...', flush=True)
        t0 = time.time()
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM document_chunks WHERE document_id=$1", DOC_ID)
            for i, chunk in enumerate(chunks):
                await conn.execute(
                    "INSERT INTO document_chunks (document_id, org_id, study_id, chunk_index, page_number, section, content) "
                    "VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    DOC_ID, ORG_ID, None, i, chunk.get('page'), chunk.get('section'), chunk['text']
                )
        print(f'    {len(chunks)} chunks inserted in {time.time()-t0:.1f}s', flush=True)

        print('[5] Embedding chunks via Ollama (batches of 8)...', flush=True)
        t0 = time.time()
        embedder = EmbeddingClient()
        BATCH = 8
        embedded = 0
        for batch_start in range(0, len(chunks), BATCH):
            batch = chunks[batch_start:batch_start + BATCH]
            texts = [c['text'] for c in batch]
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
                embedded += len(batch)
            except Exception as e:
                print(f'    WARNING: batch {batch_start} embedding failed: {e}', flush=True)
            if (batch_start // BATCH) % 25 == 0 and batch_start > 0:
                rate = embedded / (time.time() - t0) if (time.time() - t0) > 0 else 0
                eta = (len(chunks) - embedded) / rate if rate > 0 else 0
                print(f'    Embedded {embedded}/{len(chunks)} ({time.time()-t0:.0f}s, ETA {eta:.0f}s)', flush=True)

        print(f'    Embedded {embedded}/{len(chunks)} in {time.time()-t0:.0f}s', flush=True)

        async with pool.acquire() as conn:
            await conn.execute("UPDATE documents SET status='indexed', updated_at=NOW() WHERE id=$1", DOC_ID)
        print(f'[6] Status → indexed. Total: {time.time()-t_total:.0f}s', flush=True)

    except Exception as e:
        import traceback; traceback.print_exc()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE documents SET status='error', error_message=$1, updated_at=NOW() WHERE id=$2",
                str(e), DOC_ID)
    finally:
        await pool.close()


asyncio.run(run())
