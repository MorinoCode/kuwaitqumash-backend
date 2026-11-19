#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."
exec node scripts/backup-postgres-to-r2.js

