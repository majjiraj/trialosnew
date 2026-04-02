#!/usr/bin/env python3
"""
Seed real bcrypt password hashes for the demo users.
Run this AFTER 006_multitenancy.sql has been applied.

Usage:
    pip install passlib[bcrypt] asyncpg
    python seed_passwords.py

Or via Docker:
    docker exec -i trialo-auth-service-1 python /app/seed_passwords.py
"""
import asyncio
import os
from passlib.context import CryptContext

ctx = CryptContext(schemes=["bcrypt"])

CREDENTIALS = [
    ("admin@trialo.io",       "Admin@trialo1"),
    ("admin@acme.example",    "Demo@tenant1"),
    ("analyst@acme.example",  "User@acme1"),
]


async def main():
    import asyncpg
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL env var is required")

    conn = await asyncpg.connect(db_url)
    try:
        for email, password in CREDENTIALS:
            hashed = ctx.hash(password)
            result = await conn.execute(
                "UPDATE users SET password_hash=$1 WHERE email=$2",
                hashed, email
            )
            print(f"  {email}: {result}")
    finally:
        await conn.close()

    print("Done. All seed passwords set.")


if __name__ == "__main__":
    asyncio.run(main())
