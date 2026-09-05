#!/bin/sh
set -eu

: "${MNEMURON_PRIMARY_DEVICE_ID:?Set the primary client device ID.}"
: "${MNEMURON_PRIMARY_INSTANCE_ID:?Set the primary client instance ID.}"
: "${MNEMURON_SECONDARY_DEVICE_ID:?Set the secondary client device ID.}"
: "${MNEMURON_SECONDARY_INSTANCE_ID:?Set the secondary client instance ID.}"

if [ "$(id -u)" -ne 0 ]; then
  echo "bootstrap-lxc.sh must run as root." >&2
  exit 1
fi

MNEMURON_NODE=/opt/mnemuron/node/bin/node
MNEMURON_DATABASE=/var/lib/mnemuron/mnemuron.sqlite3
MNEMURON_CREDENTIAL_DIR=/root/.mnemuron/credentials
MNEMURON_ADMIN_KEY_FILE=$MNEMURON_CREDENTIAL_DIR/admin.key
MNEMURON_PRIMARY_KEY_FILE=${MNEMURON_PRIMARY_KEY_FILE:-$MNEMURON_CREDENTIAL_DIR/chatgpt-primary.key}
MNEMURON_SECONDARY_KEY_FILE=${MNEMURON_SECONDARY_KEY_FILE:-$MNEMURON_CREDENTIAL_DIR/chatgpt-secondary.key}

if [ ! -x "$MNEMURON_NODE" ]; then
  echo "Node.js 24 is not installed at $MNEMURON_NODE." >&2
  exit 1
fi

MNEMURON_NODE_MAJOR=$($MNEMURON_NODE -p 'Number(process.versions.node.split(".")[0])')
if [ "$MNEMURON_NODE_MAJOR" -lt 24 ]; then
  echo "Mnemuron requires Node.js 24 or newer." >&2
  exit 1
fi

if ! getent group mnemuron >/dev/null 2>&1; then
  addgroup --system mnemuron
fi
if ! getent passwd mnemuron >/dev/null 2>&1; then
  adduser --system --ingroup mnemuron --home /var/lib/mnemuron \
    --no-create-home --disabled-login mnemuron
fi

install -d -m 0755 -o root -g root /opt/mnemuron/server
install -d -m 0750 -o root -g mnemuron /etc/mnemuron
install -d -m 0700 -o mnemuron -g mnemuron /var/lib/mnemuron
install -d -m 0700 -o root -g root "$MNEMURON_CREDENTIAL_DIR"

install -m 0640 -o root -g mnemuron \
  /opt/mnemuron/server/config/mnemuron.env.example \
  /etc/mnemuron/mnemuron.env
sed -i 's/^MNEMURON_HOST=.*/MNEMURON_HOST=0.0.0.0/' /etc/mnemuron/mnemuron.env
install -m 0644 -o root -g root \
  /opt/mnemuron/server/systemd/mnemuron.service \
  /etc/systemd/system/mnemuron.service

umask 077
MNEMURON_BOOTSTRAP_JSON=$(mktemp)
MNEMURON_AGENT_JSON=$(mktemp)
trap 'rm -f "$MNEMURON_BOOTSTRAP_JSON" "$MNEMURON_AGENT_JSON"' EXIT INT TERM

if [ ! -f "$MNEMURON_ADMIN_KEY_FILE" ]; then
  if [ -s "$MNEMURON_DATABASE" ]; then
    echo "Database exists but the local admin key file is missing; refusing to create an unrecoverable credential mismatch." >&2
    exit 1
  fi
  MNEMURON_DATABASE_PATH=$MNEMURON_DATABASE \
    "$MNEMURON_NODE" /opt/mnemuron/server/bin/mnemuron-admin.mjs bootstrap-admin \
    > "$MNEMURON_BOOTSTRAP_JSON"
  "$MNEMURON_NODE" -e '
    const fs = require("node:fs");
    const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[2], `${input.api_key}\n`, { mode: 0o600 });
  ' "$MNEMURON_BOOTSTRAP_JSON" "$MNEMURON_ADMIN_KEY_FILE"
fi

IFS= read -r MNEMURON_ADMIN_KEY < "$MNEMURON_ADMIN_KEY_FILE"

register_agent() {
  MNEMURON_TARGET_KEY_FILE=$1
  MNEMURON_DEVICE_ID_VALUE=$2
  MNEMURON_INSTANCE_ID_VALUE=$3
  MNEMURON_LABEL_VALUE=$4
  if [ -f "$MNEMURON_TARGET_KEY_FILE" ]; then
    return
  fi
  MNEMURON_DATABASE_PATH=$MNEMURON_DATABASE \
  MNEMURON_ADMIN_API_KEY=$MNEMURON_ADMIN_KEY \
    "$MNEMURON_NODE" /opt/mnemuron/server/bin/mnemuron-admin.mjs register-agent \
    --device "$MNEMURON_DEVICE_ID_VALUE" \
    --agent chatgpt \
    --instance "$MNEMURON_INSTANCE_ID_VALUE" \
    --label "$MNEMURON_LABEL_VALUE" \
    > "$MNEMURON_AGENT_JSON"
  "$MNEMURON_NODE" -e '
    const fs = require("node:fs");
    const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[2], `${input.api_key}\n`, { mode: 0o600 });
  ' "$MNEMURON_AGENT_JSON" "$MNEMURON_TARGET_KEY_FILE"
  : > "$MNEMURON_AGENT_JSON"
}

register_agent "$MNEMURON_PRIMARY_KEY_FILE" \
  "$MNEMURON_PRIMARY_DEVICE_ID" "$MNEMURON_PRIMARY_INSTANCE_ID" "Primary ChatGPT client"
register_agent "$MNEMURON_SECONDARY_KEY_FILE" \
  "$MNEMURON_SECONDARY_DEVICE_ID" "$MNEMURON_SECONDARY_INSTANCE_ID" "Secondary ChatGPT client"

MNEMURON_DATABASE_PATH=$MNEMURON_DATABASE \
MNEMURON_ADMIN_API_KEY=$MNEMURON_ADMIN_KEY \
  "$MNEMURON_NODE" /opt/mnemuron/server/bin/mnemuron-admin.mjs seed-project \
  --file /opt/mnemuron/server/seed/projects.v0.1.json >/dev/null

MNEMURON_DATABASE_PATH=$MNEMURON_DATABASE \
MNEMURON_ADMIN_API_KEY=$MNEMURON_ADMIN_KEY \
  "$MNEMURON_NODE" /opt/mnemuron/server/bin/mnemuron-admin.mjs seed-task \
  --file /opt/mnemuron/server/seed/tasks.v0.1.json >/dev/null

unset MNEMURON_ADMIN_KEY
chown -R mnemuron:mnemuron /var/lib/mnemuron
chmod 0600 "$MNEMURON_DATABASE" 2>/dev/null || true

systemctl daemon-reload
systemctl enable --now mnemuron.service

echo "Mnemuron LXC bootstrap completed."
echo "Credentials were stored under /root/.mnemuron/credentials and were not printed."
