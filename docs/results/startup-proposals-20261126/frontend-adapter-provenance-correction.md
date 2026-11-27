# Generated adapter provenance correction

2026-11-27. Parent discovered second reconstruction flaw: checked-in vfs.js matching original SOURCE COMMIT is not necessarily the generated adapter produced by that commit's CI build. stdlib_cache.sh:200-203 runs copy_vfs_bindings then saves generated-vfs-bindings.txt, while core optimization/build changes export mapping. Source-tree equivalence is insufficient ABI evidence.

Downloaded run45131532216 artifact lock-build-batching-on-finish to target/startup-js-boundary-20261126/original-build-logs. Exact generated adapter SHA2561c054b321970ade528428adfa23ece00d7bfac46d78820a9b63d80078f18fdf4 vs checked-in originalcbcdcf7de90f179a3ad3c3618e853c400855f385fb14c3b6ed6bf177df26b04e. These differ; previous recreated previews not trustworthy. Copy only exact validated CI-generated adapter into disposable hosted checkout. Existing local dirty bindings never overwritten.

Cancelled running45961080208 after this finding, not a performance result. First failed45960165266 could involve both missing v1 assets AND incompatible adapter; no single-cause claim. Local off/on frontend-build-identities records correct core/cache but not correct adapter; do not use those outputs for speed or startup interpretation. Build success proves syntactic compilation only.

Next workflow restores preview v1 assets + exact adapter/core, rebuilds two frontends, then measures real editor behavior. No deploy. Broader host/worker code changes since preview require further audit if baseline still fails.
