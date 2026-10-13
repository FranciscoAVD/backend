#!/bin/sh
set -e
cd /app
exec bun run payments:reconcile
