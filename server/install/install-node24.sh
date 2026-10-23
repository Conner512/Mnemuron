#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-node24.sh must run as root." >&2
  exit 1
fi

if [ "$(uname -m)" != "x86_64" ]; then
  echo "This installer currently supports x86_64 only." >&2
  exit 1
fi

MNEMURON_NODE_TMP=$(mktemp -d)
trap 'rm -rf "$MNEMURON_NODE_TMP"' EXIT INT TERM

download_file() {
  MNEMURON_DOWNLOAD_URL=$1
  MNEMURON_DOWNLOAD_TARGET=$2
  if command -v curl >/dev/null 2>&1; then
    curl -4 -fsSL --connect-timeout 20 --max-time 180 \
      "$MNEMURON_DOWNLOAD_URL" -o "$MNEMURON_DOWNLOAD_TARGET"
  elif command -v wget >/dev/null 2>&1; then
    wget -4 -q --timeout=20 --tries=3 \
      -O "$MNEMURON_DOWNLOAD_TARGET" "$MNEMURON_DOWNLOAD_URL"
  else
    echo "Node.js installation requires curl or wget." >&2
    exit 1
  fi
}

download_file https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt \
  "$MNEMURON_NODE_TMP/SHASUMS256.txt"
MNEMURON_NODE_ARCHIVE=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' \
  "$MNEMURON_NODE_TMP/SHASUMS256.txt")

if [ -z "$MNEMURON_NODE_ARCHIVE" ]; then
  echo "Could not resolve the current official Node.js v24 x64 archive." >&2
  exit 1
fi

download_file "https://nodejs.org/dist/latest-v24.x/$MNEMURON_NODE_ARCHIVE" \
  "$MNEMURON_NODE_TMP/$MNEMURON_NODE_ARCHIVE"
(
  cd "$MNEMURON_NODE_TMP"
  grep " $MNEMURON_NODE_ARCHIVE\$" SHASUMS256.txt | sha256sum -c -
)

MNEMURON_NODE_DIRECTORY=${MNEMURON_NODE_ARCHIVE%.tar.xz}
tar -C /opt -xJf "$MNEMURON_NODE_TMP/$MNEMURON_NODE_ARCHIVE"
mkdir -p /opt/mnemuron
ln -sfn "/opt/$MNEMURON_NODE_DIRECTORY" /opt/mnemuron/node

/opt/mnemuron/node/bin/node --version
