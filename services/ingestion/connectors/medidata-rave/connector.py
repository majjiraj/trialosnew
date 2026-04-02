"""
Medidata Rave EDC Connector — Pull + Push modes
Uses Rave Web Services (RWS) REST API with OAuth 2.0.
Supports CDASH JSON and ODM-XML formats.
"""
import asyncio
import hashlib
import json
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Optional
import httpx
import structlog
from pydantic import BaseModel

log = structlog.get_logger()

class MedidataRaveConfig(BaseModel):
    api_base_url: str  # e.g. https://company.mdsol.com
    client_id: str
    client_secret: str
    study_oid: str  # Rave study OID
    org_id: str
    study_id: str
    connection_id: str
    environment: str = "Production"  # Production | Validation

class MedidataRaveConnector:
    """
    Medidata Rave connector via RWS API.
    Fetches clinical data in ODM-XML format, converts to CDASH JSON for Bronze.
    """

    def __init__(self, config: MedidataRaveConfig, s3_client):
        self.config = config
        self.s3 = s3_client
        self._access_token: Optional[str] = None

    async def get_access_token(self) -> str:
        """OAuth 2.0 client credentials flow."""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.config.api_base_url}/oauth/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.config.client_id,
                    "client_secret": self.config.client_secret
                }
            )
            resp.raise_for_status()
            self._access_token = resp.json()["access_token"]
            return self._access_token

    def _auth_headers(self) -> dict:
        return {"Authorization": f"Bearer {self._access_token}"}

    async def sync(self) -> dict:
        """Pull clinical data from Rave via RWS."""
        log.info("medidata_rave.sync.start", study_id=self.config.study_id)

        await self.get_access_token()

        async with httpx.AsyncClient(timeout=180.0) as client:
            # Fetch clinical data in ODM-XML
            resp = await client.get(
                f"{self.config.api_base_url}/RaveWebServices/studies/{self.config.study_oid}/datasets/regular",
                headers={**self._auth_headers(), "Accept": "text/xml"},
                params={"EnvType": self.config.environment, "rawsuffix": ""}
            )
            resp.raise_for_status()
            odm_xml = resp.text

        # Parse ODM-XML to records
        records = self._parse_odm_xml(odm_xml)
        written = await self._write_to_bronze(records, odm_xml)

        result = {
            "sync_id": str(uuid.uuid4()),
            "records_written": written,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "status": "success"
        }
        log.info("medidata_rave.sync.complete", **result)
        return result

    def _parse_odm_xml(self, odm_xml: str) -> list[dict]:
        """Convert ODM-XML to flat CDASH JSON records."""
        records = []
        try:
            root = ET.fromstring(odm_xml)
            ns = {"odm": "http://www.cdisc.org/ns/odm/v1.3"}

            for subject_data in root.findall(".//odm:SubjectData", ns):
                subject_key = subject_data.get("SubjectKey", "")

                for study_event in subject_data.findall("odm:StudyEventData", ns):
                    event_oid = study_event.get("StudyEventOID")
                    event_repeat = study_event.get("StudyEventRepeatKey")

                    for form_data in study_event.findall("odm:FormData", ns):
                        form_oid = form_data.get("FormOID")

                        for item_group in form_data.findall("odm:ItemGroupData", ns):
                            record = {
                                "SUBJECTID": subject_key,
                                "STUDYEVENTOID": event_oid,
                                "STUDYEVENTREPEATKEY": event_repeat,
                                "FORMOID": form_oid,
                            }

                            for item in item_group.findall("odm:ItemData", ns):
                                item_oid = item.get("ItemOID", "")
                                value = item.get("Value", "")
                                record[item_oid] = value

                            records.append(record)
        except ET.ParseError as e:
            log.error("odm_xml.parse_error", error=str(e))

        return records

    async def _write_to_bronze(self, records: list[dict], raw_odm: str) -> int:
        content = json.dumps(records, sort_keys=True).encode()
        sha256_hash = hashlib.sha256(content).hexdigest()
        timestamp = datetime.now(timezone.utc)

        s3_key = (
            f"{self.config.org_id}/{self.config.study_id}/"
            f"source=medidata_rave/date={timestamp.strftime('%Y-%m-%d')}/"
            f"sync_{self.config.connection_id}_{timestamp.strftime('%H%M%S')}.json"
        )

        # Write parsed JSON to Bronze
        self.s3.put_object(
            Bucket="trialo-bronze",
            Key=s3_key,
            Body=content,
            ContentType="application/json",
            Metadata={"sha256": sha256_hash, "source_system": "medidata_rave", "record_count": str(len(records))}
        )

        # Also preserve raw ODM-XML (immutable source)
        self.s3.put_object(
            Bucket="trialo-bronze",
            Key=f"{s3_key}.raw.xml",
            Body=raw_odm.encode(),
            ContentType="text/xml"
        )

        # Ingestion manifest
        manifest = {
            "manifest_version": "1.0",
            "source_system": "Medidata Rave",
            "study_oid": self.config.study_oid,
            "environment": self.config.environment,
            "extraction_timestamp": timestamp.isoformat(),
            "record_count": len(records),
            "sha256_hash": sha256_hash,
            "connector_version": "1.0.0"
        }
        self.s3.put_object(
            Bucket="trialo-bronze",
            Key=f"{s3_key}.manifest.json",
            Body=json.dumps(manifest, indent=2),
            ContentType="application/json"
        )

        return len(records)
