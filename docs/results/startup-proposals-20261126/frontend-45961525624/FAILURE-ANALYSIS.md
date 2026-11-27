# Memory import mismatch in reconstructed preview

Run45961525624 atbfc3e572,2026-11-27: featureOFF never reached ready. Captured exact error: WebAssembly.instantiate Import41 env.memory has1028pages but module minimum9203. This is an assembly/config mismatch, not RA single-init behavior: RA initialization was never reached. State stayed vfs-starting; noON or Cargo observation.

Exact retained core import inspection confirms env.memory initial9203,max65536,sharedtrue. prepare_frontend_pair now reads core import section with existing bounded inspectMemory parser (unit tested) and regenerates memory_limits.ts and worker.ts initial in disposable checkout only. Native restore verifies core hash before inspection; do not hardcode9203 or alter Wasm. Generated adapter and assets already corrected. Record memory and adapter hash with cache part identities for each arm.

No timing interpretation. Previous untouched preview diagnostic worked because generated memory config matched its core. Rebuilding frontend requires reconstructing ALL generated configuration, not just source-tree files. No local user dirty generated files changed. Browser150 run not combined with earlier Chrome157 times.
