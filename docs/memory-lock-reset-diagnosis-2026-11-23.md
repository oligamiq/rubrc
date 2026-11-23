# Reset/startup diagnosis — 2026-11-23

## Objective
Unblock the real application benchmark of bounded memory read-lock batching without reducing optimization or substituting native analyzer snapshots.

## Exact inputs and environment
- Original application: `0673d0a0b2a2fa0499fc661ec5ce1f6029c035d6`.
- Original WVL: `456a69aa9223e2e1b90cf260c573f31782987238`, waiter-aware lock, batching OFF.
- Original final core SHA256: `375a07601afac782b81ffd7d49a0891bf7980cca395e5deabd918e569ea06502`.
- Verified analyzer before WVL SHA256: `32e175b2b5ded343a87c6300345a7c04148637c4f950cf2f92f3e55d765a5e0e`.
- Hosted Ubuntu24.04, Deno2.9.7, Binaryen131, Rust nightly2026-09-13. Rust O3/fat LTO/1CGU; analyzer/final core O3; WVL max-compatible O4 with its existing EH ceiling.
- Original final optimization succeeded in36m44s; cache generation subsequently timed out after1800000ms.

## Reproduction and preserved evidence
The old source and final optimizer outputs were restored, not rebuilt, using `scripts/ci/restore_cache_diagnostic.mjs`. It verifies optimizer proof identity, output SHA, exact original source, and WVL template revision. Original app-specific adapters are preserved. The imported memory minimum is9203pages; using the tracked generated initial value would not reproduce the core configuration.

Run diagnostic via the registered dispatcher:

```sh
gh workflow run 378086753 --repo oligamiq/rubrc \
  --ref perf/memory-lock-batching -f mode=cache-startup-diagnostic
```

The diagnostic workflow revisions select different probes; consult each run's immutable source, not just today's branch:

| Run | Probe | Observed outcome |
| --- | --- | --- |
| 45087383256 | Cache command,300000ms | Timeout; captured host terminal output only shell/sysroot session0 |
| 45098532999 | `rust-analyzer --version`,300000ms | Same timeout after successful reserve |
| 45099671233 | Existing editor dispatch,30s | `_reset:enter`, no observed return |
| 45115906635 | Editor dispatch plus nonlocking snapshots | Lock0 throughout; shared guard2 before,1 for all six later samples |

Logs are retained under `target/lock-batching-evidence/<run>/artifacts/cache-startup-diagnostic-<run>/`, including `cache.log`, `resources.log`, `restore.json`, `restored-core-sha256.txt`, `application-overlay.txt`, and `result.json`. A diagnostic exit0 means evidence collection completed, not LSP readiness.

Original expensive optimizer archives:
- `target/lock-batching-evidence/recovery-checkpoints/batching-off-finish.zip`, SHA256 `a1a5ba966c2c4f5f21217345cb9cdd8b84e84c243238d542fafb96738d17a091`.
- `target/lock-batching-evidence/recovery-checkpoints/batching-on-component.zip`, SHA256 `8db2b8f2448b8efb9832be8376155d5226d28b8f334e9296bf2f4eaf466ad4ea`.

## Diagnosis
The initial CPU/RSS plateau suggested blocking but did not prove deadlock. Exact-core observation and selective disassembly identified a more specific deterministic trap mechanism.

Exact-core memory locations (invalid for any other core hash): relocation lock1121964, LSP byte-base slot1121832, logical-page slot1121288, shared initialization guard at base+2927520. Observed base595656704, pages45, relocation lock0, guard2→1. Nonlocking snapshots do not identify owners and do not exclude relocation ABA.

Function242310 (file offset689228009,118bytes) performs reset. It does NOT hold a relocation read lock across the entire call. The fill is read-locked; flesh-start function188441 is called afterwards.

Function188441 (offset494338491,68291bytes) CASes the shared once guard0→1 and replays data initialization. It also contains a mutable-global13 dropped-segment check:

```text
file offset494406216: 23 0d 04 40 00 0b
  global.get13; if; unreachable; end
file offset494406777: 41 01 24 0d 0b
  i32.const1; global.set13; end
```

Its module-start execution sets13=1, including the branch that skips shared initialization in a subsequent worker instance. Reset clears shared memory, but does not reset this late-added global. Replayed initialization sets shared guard1 then traps at the check, after releasing the read lock. This matches observed lock0/guard1. The exact pre-WVL analyzer has only the original stack/TLS mutable globals, so this extra state was introduced by WVL's internal optimization.

Binaryen MemoryPacking replaces passive zero-range initialization/drop with a synthetic dropped-state global, a guard/trap, and fills. Reference: https://raw.githubusercontent.com/WebAssembly/binaryen/version_131/src/passes/MemoryPacking.cpp . WVL's old post-combine removal of literal `data.drop` happens too late to remove this encoded state.

## Fix and verification
WVL `77f45543eb976e4e7843e78fcd67bd837acac6bd` adds `PreserveResetDataPreTargetStreamPass` before the first target optimizer. It removes only nullary `data.drop` opcodes, preserving other body/section bytes, and keeps the existing late defensive removal. No optimizer level, relocation protocol, or readiness condition is weakened.

Reproducible focused regression:

```sh
cargo test --locked -p wasi_virt_layer-cli --lib preserve_reset_data -- --nocapture
```

The tiny fixture uses shared memory, a680-byte passive zero segment, initial start, memory reset, and a second start in the same instance. It uses the real pass, not regex replacements. For both O3 and O4:
- Old order (optimize then remove drops): RuntimeError, shared guard1.
- Fixed order (remove drops then optimize): returns, shared guard2.

Four focused tests passed locally with Binaryen120/Node; hosted required gate45130504077 passed with Binaryen131/Deno and existing batching/relocation tests. Raw gate logs are under `target/lock-batching-evidence/45130504077/artifacts/ci-logs/`.

## Remaining work and boundaries
- Fresh paired app run45131532216 uses source `ff3e160d74cf2be990d0b0b39d764b306833e6bd`, the fixed WVL revision, and NO old checkpoint producer. Both seed stages passed; expensive downstream optimizations remain underway at the last observation.
- Both candidate and baseline need actual startup/cache completion and paired browser measurement. Neither gate success nor the microbenchmark establishes application speedup.
- Externally preoptimized inputs may already encode dropped-segment state; the new pass cannot generically reconstruct arbitrary earlier optimizer transformations. The exact analyzer used here was checked not to contain that state before WVL.
- Old checkpoint proofs must never be relabeled as new-generator outputs.
