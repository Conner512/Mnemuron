#!/bin/sh
set -eu

MNEMURON_BACKUP_FILE=${1:-/var/lib/mnemuron/backups/mnemuron.sqlite3}
MNEMURON_ADMIN_KEY_FILE=/root/.mnemuron/credentials/admin.key

if [ ! -r "$MNEMURON_ADMIN_KEY_FILE" ]; then
  echo "Mnemuron admin key file is unavailable." >&2
  exit 1
fi

IFS= read -r MNEMURON_ADMIN_KEY < "$MNEMURON_ADMIN_KEY_FILE"
MNEMURON_DATABASE_PATH=/var/lib/mnemuron/mnemuron.sqlite3 \
MNEMURON_ADMIN_API_KEY=$MNEMURON_ADMIN_KEY \
  /opt/mnemuron/node/bin/node /opt/mnemuron/server/bin/mnemuron-admin.mjs backup \
  --file "$MNEMURON_BACKUP_FILE"
unset MNEMURON_ADMIN_KEY
