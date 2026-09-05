-- docs/DESIGN.md §1.4, §4.8; docs/DECISIONS.md D-23
-- Requires a superuser / owner connection (DATABASE_URL_ADMIN). Runs inside one transaction.

CREATE EXTENSION IF NOT EXISTS vector;

-- pgmq is installed from the vendored SQL file instead of CREATE EXTENSION (D-23).
-- @include pgmq/pgmq.sql

SELECT pgmq.create('document_jobs');
