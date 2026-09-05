#!/bin/sh

set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: mnemuron-ct131-monitor.sh RUN_ID EVIDENCE_DIR BASELINE_PID BASELINE_RESTARTS" >&2
  exit 64
fi

run_id=$1
evidence_dir=$2
baseline_pid=$3
baseline_restarts=$4
memory_stop_bytes=751619276
swap_stop_delta_bytes=33554432

umask 077
mkdir -p "$evidence_dir"
resource_file="$evidence_dir/ct131-host-resources.csv"
stop_file="$evidence_dir/ct131-stop-reason.txt"
printf '%s\n' 'captured_at,harness_pid,harness_rss_bytes,production_pid,production_memory_bytes,combined_rss_bytes,production_restarts,production_active,swap_used_bytes,swap_delta_bytes,swap_growth_samples,filesystem_free_percent' > "$resource_file"

started=0
wait_count=0
previous_swap=-1
baseline_swap=-1
swap_growth_samples=0
stop_reason=none

while :; do
  harness_pid=$(pgrep -f "^/opt/mnemuron/node/bin/node .*/mnemuron-capacity-harness.mjs .*--run-id ${run_id}" | head -n 1 || true)
  if [ -z "$harness_pid" ]; then
    if [ "$started" -eq 1 ]; then
      break
    fi
    wait_count=$((wait_count + 1))
    if [ "$wait_count" -ge 30 ]; then
      stop_reason=harness_not_found
      break
    fi
    sleep 1
    continue
  fi
  started=1

  captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  harness_rss_kib=$(awk '/^VmRSS:/ {print $2}' "/proc/$harness_pid/status")
  harness_rss_bytes=$((harness_rss_kib * 1024))
  production_pid=$(systemctl show mnemuron.service -p MainPID --value)
  production_restarts=$(systemctl show mnemuron.service -p NRestarts --value)
  production_active=$(systemctl is-active mnemuron.service || true)
  production_memory_bytes=$(systemctl show mnemuron.service -p MemoryCurrent --value)
  combined_rss_bytes=$((harness_rss_bytes + production_memory_bytes))
  swap_used_bytes=$(free -b | awk '/^Swap:/ {print $3}')
  if [ "$baseline_swap" -lt 0 ]; then
    baseline_swap=$swap_used_bytes
  fi
  swap_delta_bytes=$((swap_used_bytes - baseline_swap))
  if [ "$swap_delta_bytes" -lt 0 ]; then
    swap_delta_bytes=0
  fi
  filesystem_free_percent=$(df -P /var/lib/mnemuron | awk 'NR == 2 {gsub(/%/, "", $5); print 100 - $5}')

  if [ "$previous_swap" -ge 0 ] && [ "$swap_used_bytes" -gt "$previous_swap" ]; then
    swap_growth_samples=$((swap_growth_samples + 1))
  else
    swap_growth_samples=0
  fi
  previous_swap=$swap_used_bytes

  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$captured_at" "$harness_pid" "$harness_rss_bytes" "$production_pid" \
    "$production_memory_bytes" "$combined_rss_bytes" "$production_restarts" \
    "$production_active" "$swap_used_bytes" "$swap_delta_bytes" "$swap_growth_samples" \
    "$filesystem_free_percent" >> "$resource_file"

  if [ "$combined_rss_bytes" -ge "$memory_stop_bytes" ]; then
    stop_reason=combined_rss_stop_threshold
  elif [ "$filesystem_free_percent" -lt 20 ]; then
    stop_reason=filesystem_stop_threshold
  elif [ "$production_pid" != "$baseline_pid" ] || [ "$production_restarts" != "$baseline_restarts" ]; then
    stop_reason=production_service_restarted
  elif [ "$production_active" != active ]; then
    stop_reason=production_service_unavailable
  fi

  if [ "$swap_growth_samples" -ge 3 ] && [ "$swap_delta_bytes" -ge "$swap_stop_delta_bytes" ]; then
    stop_reason=material_swap_growth_three_samples
  fi

  if [ "$stop_reason" != none ]; then
    kill -TERM "$harness_pid"
    break
  fi
  sleep 5
done

printf '%s\n' "$stop_reason" > "$stop_file"
chmod 0600 "$resource_file" "$stop_file"

if [ "$stop_reason" != none ]; then
  echo "$stop_reason" >&2
  exit 2
fi
