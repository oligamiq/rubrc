#!/usr/bin/env bash
set -euo pipefail

[[ "${GITHUB_ACTIONS:-}" == true ]] || { printf 'Optimizer memory setup is CI-only.\n' >&2; exit 2; }
swap_file="${RUNNER_TEMP:?}/rubrc-optimizer.swap"

case "${1:-}" in
  prepare)
    free -m
    sysctl vm.overcommit_memory vm.overcommit_ratio
    df -h "$RUNNER_TEMP"
    available_bytes=$(( $(stat -f -c %a "$RUNNER_TEMP") * $(stat -f -c %S "$RUNNER_TEMP") ))
    test "$available_bytes" -ge 51539607552
    test ! -e "$swap_file"
    sudo install -m 600 /dev/null "$swap_file"
    sudo fallocate -l 32G "$swap_file"
    sudo mkswap "$swap_file"
    sudo swapon "$swap_file"
    free -m
    swapon --show --bytes
    # No per-service RAM throttling/cap: use the runner's available RAM.
    sudo systemd-run --wait --pipe --collect \
      --uid="$(id -u)" --gid="$(id -g)" --working-directory="$PWD" \
      --property=MemoryAccounting=yes --property=MemoryHigh=infinity \
      --property=MemoryMax=infinity --property=MemorySwapMax=infinity \
      --property=LimitAS=infinity --property=LimitCORE=0 \
      --property=OOMScoreAdjust=500 --property=OOMPolicy=kill \
      --property=RuntimeMaxSec=90min --property=TimeoutStopSec=30s \
      /usr/bin/true
    ;;
  cleanup)
    # A cancelled systemd-run client may leave its service running.
    sudo systemctl stop "rubrc-wasm-opt-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}.service" 2>/dev/null || true
    swap_names=$(swapon --show=NAME --noheadings)
    if printf '%s\n' "$swap_names" | grep -Fxq -- "$swap_file"; then
      sudo swapoff "$swap_file"
    fi
    sudo rm -f -- "$swap_file"
    ;;
  *) printf 'Usage: %s {prepare|cleanup}\n' "$0" >&2; exit 2 ;;
esac
