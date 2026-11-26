# Loom 0.7.2 implementation notes

Inspected locally on 2026-11-26 after resolving the exact `loom = "=0.7.2"`
dependency; transitive versions/checksums are fixed by [Cargo.lock](<Cargo.lock>).
These implementation observations explain interpretation limits, not an
independent proof of the Rust/C++ memory model.

## Inherited release synchronization across RMWs

Upstream source locations (paths inside the Loom 0.7.2 crate):

- `src/rt/atomic.rs:529-536`: successful RMW first invokes
  `self.stores[index].sync.sync_load(threads, success)`, copies
  `let sync = self.stores[index].sync`, and passes that to
  `self.store(threads, sync, next, success)`. Loom's own comment calls this
  its “(hacky) way to establish a release sequence.”
- `src/rt/synchronize.rs:39-61`: `sync_store` joins the active thread's
  released vector; Release/AcqRel call `sync_rel`, which **joins** active
  causality into the existing synchronization vector (does not replace it).
  Acquire loads join that inherited vector into the acquiring thread.

The actual readers-to-writer case exercises two Release fetch-sub operations
and, for schedules taking that path, a Relaxed marker-registration RMW.
Loom propagates inherited release state through successful RMWs; the
observed successful payload assertions are meaningful within that model.
Do not mistake this implementation for an independent language-model proof,
or assume all memory-model release-sequence subtleties are modeled.
The harness does not replace either fetch-sub with a load/store sequence.
No assertion of marker-path schedule coverage is made: we deliberately did
not instrument the production algorithm beyond the documented substitutions.

## Iteration caps

`src/model.rs:141` starts `i = 1`; lines 166-188 check caps **before** running
an iteration; lines 206-216 increment `i` and step the execution path. With
checkpoint interval 1 and max_permutations 1000, the cap allows 999 model
closure invocations. A clean return may therefore mean a bounded prefix,
not exhausted search. The default runner clears all `LOOM_*` environment
variables, including checkpoint paths, and sets explicit caps. It reports
both actual closure starts and completions. The configured preemption bound
of 2 remains a restriction even when the small bounded search finishes.

## Wait and spurious-CAS scope

The backend's wait is only a Loom yield; notify does nothing. This backend
is not an atomic compare-and-park implementation. Production loops and
memory orderings remain unchanged, but scheduler exploration has branch
and preemption limits. Loom is not a proof of all weak-CAS spurious-failure
behaviors, arbitrary starvation, waiter wakeups, or hardware/compiler
lowerings. The small payload cases do not assess these properties.
