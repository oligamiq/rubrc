#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
ANALYZER="$ROOT/../rust-analyzer"
LOGS="$ROOT/ci-logs"
mkdir -p "$LOGS"

case "${1:-}" in
  checks)
    rustc -Vv
    cargo -V
    cargo test --locked --manifest-path "$ANALYZER/Cargo.toml" -p parking_lot_core --lib
    cargo test --locked --manifest-path "$ANALYZER/Cargo.toml" -p ide-db -p rust-analyzer --lib semantic_cache
    cargo test --locked --manifest-path "$ANALYZER/Cargo.toml" -p ide-db --lib semantic_cache --features cache-item-trees,cache-codec-bench
    cargo test --locked -p vfs --lib
    deno test --no-lock --allow-read --allow-env \
      page/src/stdlib_cache_test.ts page/src/worker_process/lsp_dispatch_test.ts \
      page/src/startup_coordinator_test.ts page/src/workspace_sync_test.ts
    deno test --no-lock --allow-read --allow-env page/src/startup_measurements_test.ts page/src/startup_sysroot_measurement_test.ts page/src/lsp_test_api_state_test.ts page/src/vfs_readiness_test.ts
    deno test --no-lock --allow-read --allow-env page/src/sysroot_transfer_timeout_test.ts page/src/sysroot_archive_test.ts page/src/sysroot_archive_store_test.ts
    deno test --no-lock lib/src/compressed_progress_test.ts lib/src/fetch_compressed_stream_test.ts
    node --test scripts/copy_vfs_bindings_test.mjs scripts/finalize_vfs_asset_test.mjs \
      scripts/stdlib_cache_browser_support_test.mjs scripts/startup_measurement_support_test.mjs
    ;;
  tools)
    tools="$RUNNER_TEMP/stdlib-cache-tools"
    mkdir -p "$tools/wvl" "$tools/wasm-tools" "$tools/binaryen"
    download() {
      local url=$1 file=$2 hash=$3
      curl --fail --location --retry 2 --output "$file" "$url"
      printf '%s  %s\n' "$hash" "$file" | sha256sum --check -
    }
    download 'https://github.com/oligamiq/wasi_virt_layer/releases/download/v0.10.0/wasi_virt_layer-cli-x86_64-unknown-linux-gnu.tar.xz' \
      "$tools/wvl.tar.xz" c7bc0f357a1d5e12c8d95b360c377f4801c36085256e4281c444d47d4eaedba6
    download 'https://github.com/bytecodealliance/wasm-tools/releases/download/v1.252.0/wasm-tools-1.252.0-x86_64-linux.tar.gz' \
      "$tools/wasm-tools.tar.gz" 097b1181d5b2bc3f2ebc44b4e72edf18308902023f1f1483a1a7dc1268ea988d
    download 'https://github.com/WebAssembly/binaryen/releases/download/version_131/binaryen-version_131-x86_64-linux.tar.gz' \
      "$tools/binaryen.tar.gz" b5bf1f0eaf17c63ee588ff7a5954dc8f6ce2c26989051c66f24dfe9ece3e46db
    tar -xf "$tools/wvl.tar.xz" -C "$tools/wvl" --strip-components=1
    tar -xf "$tools/wasm-tools.tar.gz" -C "$tools/wasm-tools" --strip-components=1
    tar -xf "$tools/binaryen.tar.gz" -C "$tools/binaryen" --strip-components=1
    printf '%s\n' "$tools/wvl" "$tools/wasm-tools" "$tools/binaryen/bin" >> "$GITHUB_PATH"
    "$tools/wvl/wasi_virt_layer" --version
    "$tools/wasm-tools/wasm-tools" --version
    "$tools/binaryen/bin/wasm-opt" --version
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends squashfs-tools squashfs-tools-ng
    # Ubuntu 24.04's classic mksquashfs predates the reproducibility/mode flags
    # used by the archive builder. Its existing gensquashfs fallback is supported.
    # Exercise archive generation before spending time on analyzer/VFS builds.
    bun run rust-src:prepare-asset "$RUNNER_TEMP/stdlib-cache-rust-src-check.sqfs"
    ;;
  build)
    export RUSTC
    RUSTC=$(rustup which rustc --toolchain "$RA_TOOLCHAIN")
    {
      git rev-parse HEAD
      git -C "$ANALYZER" rev-parse HEAD
      rustc -Vv
      cargo -V
      node --version
      bun --version
      deno --version
      wasi_virt_layer --version
      wasm-tools --version
      wasm-opt --version
      printf 'VFS_CORE_OPT_LEVEL=%s\n' "${VFS_CORE_OPT_LEVEL:-none}"
      free -h
      df -h .
    } > "$LOGS/build-identity.txt"
    RUSTFLAGS='-Copt-level=2 -Ccodegen-units=1' bun run lsp:build
    wasi_virt_layer build -p vfs \
      crates/vfs/llvm_opt.wasm crates/vfs/rustc_opt.wasm crates/vfs/lsp_opt.wasm \
      crates/vfs/cargo_opt.wasm vfs-shell \
      --features debug-log --dev --own-memory --vfs-unwind --validate
    wasm-tools validate --features all dist/vfs.core.wasm
    if [[ -n "${GITHUB_ENV:-}" ]]; then
      printf 'ACTUAL_VFS_CORE_OPT_LEVEL=none\nCORE_OPT_FAILED=0\n' >> "$GITHUB_ENV"
    fi
    case "${VFS_CORE_OPT_LEVEL:-none}" in
      none) ;;
      O1)
        # One bounded trial on the final core: its export ABI remains unchanged,
        # and cache generation below runs this exact optimized module.
        stat -c 'before: %s bytes' dist/vfs.core.wasm > "$LOGS/core-optimization.txt"
        optimizer_unit="rubrc-wasm-opt-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}.service"
        (
          monitor_started=$SECONDS
          checkpoint_logged=false
          while true; do
            date -u +%FT%TZ
            free -m
            swapon --show --bytes
            ps -C wasm-opt -o pid,rss,vsz,pcpu,etime || true
            systemctl show "$optimizer_unit" --no-pager \
              -p MemoryCurrent -p MemoryPeak -p MemorySwapCurrent -p Result 2>/dev/null || true
            if (( SECONDS - monitor_started >= 1800 )) && [[ "$checkpoint_logged" == false ]]; then
              printf 'Optimizer passed the 30-minute progress checkpoint; continuing within the 90-minute emergency deadline.\n'
              checkpoint_logged=true
            fi
            sleep 15
          done
        ) &
        monitor_pid=$!
        trap 'sudo systemctl stop "$optimizer_unit" 2>/dev/null || true; kill "$monitor_pid" 2>/dev/null || true' EXIT
        # VSZ can exceed working-set size substantially. Control resident/cgroup
        # memory and swap separately instead of failing mmap at an artificial
        # address-space cap. Leave RAM and swap headroom for the hosted runner.
        if sudo systemd-run --unit="$optimizer_unit" --wait --pipe --collect \
            --uid="$(id -u)" --gid="$(id -g)" --working-directory="$ROOT" \
            --setenv="PATH=$PATH" --setenv=BINARYEN_CORES=1 \
            --property=MemoryAccounting=yes --property=MemoryHigh=11G \
            --property=MemoryMax=12G --property=MemorySwapMax=28G \
            --property=LimitAS=infinity --property=LimitCORE=0 \
            --property=RuntimeMaxSec=90min --property=TimeoutStopSec=30s \
            /usr/bin/time -v -o "$LOGS/core-optimization-time.txt" \
            wasm-opt -O1 --enable-threads --enable-bulk-memory \
            --enable-reference-types --enable-exception-handling --enable-simd \
            --enable-multivalue --enable-mutable-globals --enable-sign-ext \
            --enable-nontrapping-float-to-int --enable-extended-const \
            dist/vfs.core.wasm -o dist/vfs.core.optimized.wasm \
            && wasm-tools validate --features all dist/vfs.core.optimized.wasm; then
          mv dist/vfs.core.optimized.wasm dist/vfs.core.wasm
          printf 'optimization applied\n' >> "$LOGS/core-optimization.txt"
          if [[ -n "${GITHUB_ENV:-}" ]]; then printf 'ACTUAL_VFS_CORE_OPT_LEVEL=O1\n' >> "$GITHUB_ENV"; fi
        else
          rm -f dist/vfs.core.optimized.wasm
          printf 'optimization failed; original validated core retained\n' >> "$LOGS/core-optimization.txt"
          if [[ -n "${GITHUB_ENV:-}" ]]; then printf 'CORE_OPT_FAILED=1\n' >> "$GITHUB_ENV"; fi
        fi
        kill "$monitor_pid" 2>/dev/null || true
        wait "$monitor_pid" 2>/dev/null || true
        trap - EXIT
        stat -c 'after: %s bytes' dist/vfs.core.wasm >> "$LOGS/core-optimization.txt"
        # Keep the outcome and termination report in the longer-lived job log,
        # not only in the one-day diagnostic artifact.
        cat "$LOGS/core-optimization.txt"
        if [[ -f "$LOGS/core-optimization-time.txt" ]]; then
          cat "$LOGS/core-optimization-time.txt"
        fi
        ;;
      *) printf 'Unsupported VFS_CORE_OPT_LEVEL\n' >&2; exit 2 ;;
    esac
    node scripts/copy_vfs_bindings.mjs
    bun install --cwd page/src/worker_process/vfs_bindings
    # Keep the small generated adapter as a diagnostic, never the WASM payload.
    cp page/src/worker_process/vfs_bindings/vfs.js "$LOGS/generated-vfs-bindings.txt"
    sha256sum crates/vfs/lsp_opt.wasm dist/vfs.core.wasm \
      page/src/worker_process/vfs_bindings/vfs.core.wasm > "$LOGS/artifact-sha256.txt"
    bun run std-cache:generate target/std.salsa
    VITE_RUBRC_LSP_TEST=1 VITE_RUBRC_STD_CACHE_COMPARE=1 bun run --cwd page build
    VFS_BROTLI_QUALITY=1 bun run vfs:prepare:prod
    bun run rust-src:prepare-asset
    bun run std-cache:prepare-asset target/std.salsa page/dist
    sha256sum target/std.salsa >> "$LOGS/artifact-sha256.txt"
    ;;
  browser)
    bunx puppeteer browsers install chrome
    RUBRC_STDLIB_RUNS=3 RUBRC_STDLIB_TIMEOUT_MS=360000 \
      node scripts/stdlib_cache_browser_test.mjs
    ;;
  measure)
    bunx puppeteer browsers install chrome
    RUBRC_MEASURE_PROFILE=normal node scripts/measure_startup_device.mjs
    RUBRC_MEASURE_PROFILE=constrained node scripts/measure_startup_device.mjs
    ;;
  *)
    printf 'Usage: %s {checks|tools|build|browser|measure}\n' "$0" >&2
    exit 2
    ;;
esac
