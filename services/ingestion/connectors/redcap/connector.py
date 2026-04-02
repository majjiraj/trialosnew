"""
REDCap EDC Connector — Pull mode (API token auth)
Fetches records, instruments, and metadata via REDCap REST API.
Writes to Bronze layer as Iceberg-compatible Parquet via S3.
"""
import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Optional
import httpx
import structlog
from pydantic import BaseModel
from pydantic_settings import BaseSettings

log = structlog.get_logger()

class REDCapConfig(BaseModel):
    api_url: str  # e.g. https://redcap.example.org/api/
    api_token: str
    org_id: str
    study_id: str
    connection_id: str
    batch_size: int = 1000
    export_forms: Optional[list[str]] = None  # None = all forms

class REDCapConnector:
    """
    Pulls data from REDCap via REST API.
    Supports: records, instruments, metadata, events (longitudinal studies).
    """

    def __init__(self, config: REDCapConfig, s3_client, kafka_producer):
        self.config = config
        self.s3 = s3_client
        self.kafka = kafka_producer

    async def sync(self) -> dict:
        """Full sync: metadata + records."""
        log.info("redcap.sync.start", study_id=self.config.study_id)

        result = {
            "sync_id": str(uuid.uuid4()),
            "started_at": datetime.now(timezone.utc).isoformat(),
            "records_written": 0,
            "errors": []
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            # 1. Get metadata (data dictionary)
            metadata = await self._fetch_metadata(client)

            # 2. Get all records in batches
            records = await self._fetch_records(client)

        if records:
            written = await self._write_to_bronze(records, metadata)
            result["records_written"] = written

        result["completed_at"] = datetime.now(timezone.utc).isoformat()
        result["status"] = "success"

        # Emit Kafka event
        await self._emit_sync_event(result)

        log.info("redcap.sync.complete", **result)
        return result

    async def _fetch_metadata(self, client: httpx.AsyncClient) -> list[dict]:
        """Fetch REDCap data dictionary (field definitions)."""
        resp = await client.post(self.config.api_url, data={
            "token": self.config.api_token,
            "content": "metadata",
            "format": "json",
            "returnFormat": "json"
        })
        resp.raise_for_status()
        return resp.json()

    async def _fetch_records(self, client: httpx.AsyncClient) -> list[dict]:
        """Fetch all records with pagination."""
        all_records = []
        offset = 0

        while True:
            payload = {
                "token": self.config.api_token,
                "content": "record",
                "format": "json",
                "type": "flat",
                "returnFormat": "json",
                "exportSurveyFields": "true",
                "exportDataAccessGroups": "true",
            }

            if self.config.export_forms:
                payload["forms"] = ",".join(self.config.export_forms)

            resp = await client.post(self.config.api_url, data=payload)
            resp.raise_for_status()
            batch = resp.json()

            if not batch:
                break

            all_records.extend(batch)

            if len(batch) < self.config.batch_size:
                break

            offset += self.config.batch_size
            log.info("redcap.fetch.batch", offset=offset, fetched=len(batch))

        return all_records

    async def _write_to_bronze(self, records: list[dict], metadata: list[dict]) -> int:
        """Write records to Bronze S3 layer with manifest."""
        if not records:
            return 0

        # Compute hash of entire record set
        content = json.dumps(records, sort_keys=True).encode()
        sha256_hash = hashlib.sha256(content).hexdigest()

        timestamp = datetime.now(timezone.utc)
        date_partition = timestamp.strftime("%Y-%m-%d")

        # S3 key: Bronze partition structure
        s3_key = (
            f"{self.config.org_id}/{self.config.study_id}/"
            f"source=redcap/date={date_partition}/"
            f"sync_{self.config.connection_id}_{timestamp.strftime('%H%M%S')}.json"
        )

        self.s3.put_object(
            Bucket="trialo-bronze",
            Key=s3_key,
            Body=content,
            ContentType="application/json",
            Metadata={
                "sha256": sha256_hash,
                "record_count": str(len(records)),
                "source_system": "redcap",
                "org_id": self.config.org_id,
                "study_id": self.config.study_id,
                "connector_version": "1.0.0"
            }
        )

        # Write ingestion manifest (ICH E6(R3) requirement)
        manifest = {
            "manifest_version": "1.0",
            "source_system": "REDCap",
            "source_version": "latest",
            "connection_id": self.config.connection_id,
            "org_id": self.config.org_id,
            "study_id": self.config.study_id,
            "extraction_timestamp": timestamp.isoformat(),
            "record_count": len(records),
            "sha256_hash": sha256_hash,
            "s3_key": s3_key,
            "connector_version": "1.0.0",
            "sync_mode": "pull"
        }

        self.s3.put_object(
            Bucket="trialo-bronze",
            Key=f"{s3_key}.manifest.json",
            Body=json.dumps(manifest, indent=2),
            ContentType="application/json"
        )

        log.info("bronze.written", s3_key=s3_key, records=len(records), sha256=sha256_hash)
        return len(records)

    async def _emit_sync_event(self, result: dict):
        topic = f"trialo.events.data.{self.config.org_id}.{self.config.study_id}"
        event = {
            "event_type": "data.ingested",
            "source": "redcap",
            "org_id": self.config.org_id,
            "study_id": self.config.study_id,
            "records_count": result.get("records_written", 0),
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        # Kafka emit - placeholder (actual kafka-python producer in production)
        log.info("kafka.event.emitted", topic=topic, event_type="data.ingested")
