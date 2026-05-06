# TrialOS — Data Backup

Snapshot taken: **2026-05-06**

## Contents

| Path | Source | Description |
|------|--------|-------------|
| `postgres/trialo_full_dump.dump` | PostgreSQL `trialo` DB | pg_dump custom-format, compressed (~73 MB) |
| `mongodb/trialo_dump.archive.gz` | MongoDB `trialo` DB | mongodump archive (gzip) |
| `neo4j/nodes_raw.txt` | Neo4j | Raw node export (graph rebuilds automatically) |
| `neo4j/relationships_raw.txt` | Neo4j | Raw relationship export |
| `minio/objects_manifest.txt` | MinIO `trialo-documents` | Full object listing with sizes and dates |
| `minio/documents/` | MinIO `trialo-documents` | CSV datasets included; PDFs re-uploaded via UI |

## Data Summary

### PostgreSQL (key tables)

| Table | Rows | Notes |
|-------|------|-------|
| context_edges | 197,380 | Knowledge graph edges |
| context_nodes | 58,492 | Knowledge graph nodes |
| document_chunks | 5,431 | Vector-embedded protocol chunks |
| processing_logs | 388 | Document processing events |
| notifications | 114 | System notifications |
| agent_runs | 28 | Agent execution records |
| documents | 5 | Uploaded documents |
| usdm_conversions | 1 | USDM conversion (B7981041 Ritlecitinib Vitiligo) |
| studies | 2 | B7981041 (Phase III), B7981027 (Phase III) |
| decision_traces | 3 | Agent decision audit records |

### MongoDB

| Collection | Documents |
|------------|-----------|
| document_lineage | 30 |
| folder_files | 6 |
| document_folders | 3 |

### Neo4j

Graph data is re-populated automatically by the `agent-runtime` and `context-graph`
services as agent runs execute. The raw text exports are included for reference only.

### MinIO (`trialo-documents`)

See `minio/objects_manifest.txt` for the full listing of 116 objects.

Key documents:
- Clinical Protocol B7981041 — Ritlecitinib Nonsegmental Vitiligo (Phase III) PDF
- ICH M11 Clinical Protocol Template PDF
- SDTM Implementation Guide v3.4 PDF
- USDM-IG v4.0 PDF
- SDTM domain datasets (DM.csv, CM.csv, AE.xpt, LB.xpt, etc.)

> **Note:** Large PDFs (>1 MB) are not committed to git to keep repo size manageable.
> After restore, re-upload them via the Documents page or use the MinIO console
> at http://localhost:9001 (credentials: trialo / trialo_dev_secret).

## Restore

```bash
# Full restore (run after docker compose up -d and services are healthy)
bash data-backup/restore.sh

# Selective restore
bash data-backup/restore.sh --postgres-only
bash data-backup/restore.sh --mongodb-only
bash data-backup/restore.sh --minio-only
```

See `INSTALL.md` for the complete setup and deployment guide.
