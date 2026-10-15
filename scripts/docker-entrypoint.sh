#!/bin/sh
# Container entry point (see Dockerfile and docs/DEPLOYMENT.md).
#
# 1. Apply pending migrations. `migrate deploy` only runs migrations that are not yet
#    recorded in _prisma_migrations, each in its own transaction, and never resets data.
# 2. Replace this shell with the server so it receives SIGTERM directly and can write
#    final checkpoints before exiting.
set -eu

cd /app
echo "Applying database migrations…"
node ./node_modules/prisma/build/index.js migrate deploy --schema ./prisma/schema.prisma
echo "Starting server on ${HOST:-0.0.0.0}:${PORT:-3001}"
exec node dist/index.js
