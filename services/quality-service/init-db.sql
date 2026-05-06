-- Quality Service database initialisation
-- Run automatically by postgres on first container start via /docker-entrypoint-initdb.d/
-- Tables are created by the Python service on first boot (db.py:init_db).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
