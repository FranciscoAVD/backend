#!/bin/sh
set -e
cd /app/apps/backend
exec bun run payments:reconcile
