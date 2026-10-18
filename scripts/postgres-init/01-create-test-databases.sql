-- Run by the postgres image on first start (empty data volume) via
-- /docker-entrypoint-initdb.d. civ_dev is created from POSTGRES_DB; these are the
-- databases used by the server integration tests and the Playwright browser tests.
-- Migrations are applied separately (see docs/DEVELOPMENT.md).
CREATE DATABASE civ_test OWNER civ;
CREATE DATABASE civ_e2e OWNER civ;
