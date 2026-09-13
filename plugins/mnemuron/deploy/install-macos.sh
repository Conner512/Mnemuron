#!/bin/sh

set -eu

expected_version="0.1.14"
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugin_source="${bundle_dir}/plugin"
manifest_file="${plugin_source}/.codex-plugin/plugin.json"
cache_parent="${HOME}/.codex/plugins/cache/personal"
cache_root="${cache_parent}/mnemuron"
personal_parent="${HOME}/plugins"
personal_root="${personal_parent}/mnemuron"
config_file="${HOME}/.codex/config.toml"
backup_root="${HOME}/.mnemuron/backups"
backup_stamp=$(/bin/date -u +%Y%m%dT%H%M%SZ)
retired_cache="${backup_root}/mnemuron-plugin-cache-retired-${backup_stamp}"
failed_cache="${backup_root}/mnemuron-plugin-cache-failed-${backup_stamp}"
retired_source="${backup_root}/mnemuron-plugin-source-retired-${backup_stamp}"
failed_source="${backup_root}/mnemuron-plugin-source-failed-${backup_stamp}"
cache_staging=""
source_staging=""
cache_installed=0
source_installed=0
source_mode="managed"
install_complete=0

fail() {
  printf 'Mnemuron install failed: %s\n' "$1" >&2
  exit 1
}

rollback() {
  exit_code=$?
  trap - EXIT INT TERM
  if [ "$install_complete" -ne 1 ]; then
    if [ -n "$cache_staging" ] && [ -d "$cache_staging" ]; then
      /bin/rm -rf -- "$cache_staging"
    fi
    if [ -n "$source_staging" ] && [ -d "$source_staging" ]; then
      /bin/rm -rf -- "$source_staging"
    fi
    if [ "$cache_installed" -eq 1 ] && [ -d "$cache_root" ]; then
      if [ -d "$retired_cache" ]; then
        /bin/mv "$cache_root" "$failed_cache"
      else
        /bin/rm -rf -- "$cache_root"
      fi
    fi
    if [ -d "$retired_cache" ]; then
      /bin/mv "$retired_cache" "$cache_root"
    fi
    if [ "$source_installed" -eq 1 ] && [ -d "$personal_root" ] && [ ! -L "$personal_root" ]; then
      if [ -d "$retired_source" ]; then
        /bin/mv "$personal_root" "$failed_source"
      else
        /bin/rm -rf -- "$personal_root"
      fi
    fi
    if [ -d "$retired_source" ]; then
      /bin/mv "$retired_source" "$personal_root"
    fi
  fi
  exit "$exit_code"
}

trap rollback EXIT INT TERM

[ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "this installer only supports macOS."
[ "$cache_root" = "${HOME}/.codex/plugins/cache/personal/mnemuron" ] \
  || fail "unexpected plugin cache target."
[ "$personal_root" = "${HOME}/plugins/mnemuron" ] \
  || fail "unexpected personal plugin source target."
[ -f "$manifest_file" ] || fail "plugin manifest is missing."
[ -f "${bundle_dir}/SHA256SUMS" ] || fail "SHA256SUMS is missing."
[ -f "$config_file" ] || fail "Codex config.toml is missing."
/usr/bin/grep -Eq '^\[plugins\."mnemuron@personal"\][[:space:]]*$' "$config_file" \
  || fail "mnemuron@personal is not registered in config.toml."

plugin_version=$(/usr/bin/plutil -extract version raw -o - "$manifest_file")
[ "$plugin_version" = "$expected_version" ] || fail "unexpected plugin version ${plugin_version}."

(
  cd "$bundle_dir"
  /usr/bin/shasum -a 256 -c SHA256SUMS
) || fail "bundle checksum verification failed."

if /usr/bin/find "$plugin_source" \
  \( -type f \( -name '*.key' -o -name 'config.json' \) \
  -o -type d \( -name credentials -o -name outbox -o -name task-scopes \) \) \
  -print | /usr/bin/grep -q .; then
  fail "bundle contains runtime state or credential material."
fi

/usr/bin/install -d -m 0700 "$backup_root"
/usr/bin/install -d -m 0755 "$cache_parent" "$personal_parent"

if [ -L "$personal_root" ]; then
  source_mode="development-symlink"
  linked_manifest="${personal_root}/.codex-plugin/plugin.json"
  [ -f "$linked_manifest" ] || fail "personal plugin source symlink has no manifest."
  linked_version=$(/usr/bin/plutil -extract version raw -o - "$linked_manifest")
  [ "$linked_version" = "$expected_version" ] \
    || fail "personal plugin source symlink points to version ${linked_version}; update the linked workspace before installing."
  source_backup_archive="none (development source symlink preserved)"
elif [ -d "$personal_root" ]; then
  source_backup_archive="${backup_root}/mnemuron-chatgpt-plugin-source-pre-${plugin_version}-${backup_stamp}.tar.gz"
  /usr/bin/tar -C "$personal_parent" -czf "$source_backup_archive" mnemuron
  /bin/chmod 0600 "$source_backup_archive"
  /usr/bin/tar -tzf "$source_backup_archive" >/dev/null
else
  source_backup_archive="none (no previous personal plugin source)"
fi

if [ -d "$cache_root" ]; then
  cache_backup_archive="${backup_root}/mnemuron-chatgpt-plugin-cache-pre-${plugin_version}-${backup_stamp}.tar.gz"
  /usr/bin/tar -C "$cache_parent" -czf "$cache_backup_archive" mnemuron
  /bin/chmod 0600 "$cache_backup_archive"
  /usr/bin/tar -tzf "$cache_backup_archive" >/dev/null
else
  cache_backup_archive="none (no previous cache directory)"
fi

cache_staging=$(/usr/bin/mktemp -d "${cache_parent}/.mnemuron-cache-install.XXXXXX")
/usr/bin/install -d -m 0755 "${cache_staging}/${plugin_version}"
/bin/cp -R "${plugin_source}/." "${cache_staging}/${plugin_version}/"
/usr/bin/find "$cache_staging" -type d -exec /bin/chmod 0755 {} +
/usr/bin/find "$cache_staging" -type f -exec /bin/chmod 0644 {} +
/bin/chmod 0755 "${cache_staging}/${plugin_version}/scripts/launch-hook" "${cache_staging}/${plugin_version}/scripts/launch-mcp"

if [ "$source_mode" = "managed" ]; then
  source_staging=$(/usr/bin/mktemp -d "${personal_parent}/.mnemuron-source-install.XXXXXX")
  /bin/cp -R "${plugin_source}/." "$source_staging/"
  /usr/bin/find "$source_staging" -type d -exec /bin/chmod 0755 {} +
  /usr/bin/find "$source_staging" -type f -exec /bin/chmod 0644 {} +
  /bin/chmod 0755 "${source_staging}/scripts/launch-hook" "${source_staging}/scripts/launch-mcp"
fi

installed_version=$(/usr/bin/plutil -extract version raw -o - "${cache_staging}/${plugin_version}/.codex-plugin/plugin.json")
[ "$installed_version" = "$expected_version" ] || fail "staged manifest version mismatch."

node_bin=$(command -v node 2>/dev/null || true)
if [ -z "$node_bin" ] && [ -x "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" ]; then
  node_bin="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
fi
[ -n "$node_bin" ] && [ -x "$node_bin" ] || fail "a compatible Node.js runtime was not found."

"$node_bin" --check "${cache_staging}/${plugin_version}/scripts/mcp-core.mjs"
"$node_bin" --check "${cache_staging}/${plugin_version}/scripts/mcp-server.mjs"
"$node_bin" --test \
  "${cache_staging}/${plugin_version}/test/delivery-gate.test.mjs" \
  "${cache_staging}/${plugin_version}/test/hook.test.mjs" \
  "${cache_staging}/${plugin_version}/test/mcp-server.test.mjs" \
  "${cache_staging}/${plugin_version}/test/remote-client.test.mjs" \
  "${cache_staging}/${plugin_version}/test/task-scope-concurrency.test.mjs"

if [ -d "$cache_root" ]; then
  /bin/mv "$cache_root" "$retired_cache"
fi
/bin/mv "$cache_staging" "$cache_root"
cache_staging=""
cache_installed=1

if [ "$source_mode" = "managed" ]; then
  if [ -d "$personal_root" ]; then
    /bin/mv "$personal_root" "$retired_source"
  fi
  /bin/mv "$source_staging" "$personal_root"
  source_staging=""
  source_installed=1
fi

target_dir="${cache_root}/${plugin_version}"
[ -f "${target_dir}/.codex-plugin/plugin.json" ] || fail "installed cache manifest is missing."
[ -f "${personal_root}/.codex-plugin/plugin.json" ] || fail "installed personal source manifest is missing."
install_complete=1
trap - EXIT INT TERM

printf 'Mnemuron plugin installed successfully.\n'
printf 'Version: %s\n' "$plugin_version"
printf 'Cache installed at: %s\n' "$target_dir"
printf 'Personal source: %s (%s)\n' "$personal_root" "$source_mode"
printf 'Cache backup: %s\n' "$cache_backup_archive"
printf 'Source backup: %s\n' "$source_backup_archive"
printf 'Retired cache: %s\n' "$retired_cache"
if [ "$source_mode" = "managed" ]; then
  printf 'Retired source: %s\n' "$retired_source"
fi
printf 'Next step: fully quit ChatGPT, reopen it, then run /Mnemuron status.\n'
