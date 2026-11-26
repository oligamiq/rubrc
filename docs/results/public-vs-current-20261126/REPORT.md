# Public demo vs current implementation: evidence and limits

Date: 2026-11-26 JST. Public demo interpreted as README link https://rubrc.pages.dev/ (not the DSH GUI).

## Provenance checks

- Current experimental commit:1a06207659f0677c4f61d21b736738c08d1a83e9; main:8c012fc2db16782271a8b91def1ccca8d117b057.
- web_fetch of https://rubrc.pages.dev/.rubrc-pages-build.json returned200 HTML titled Rubrc, not build JSON. Therefore no public source SHA obtained.
- https://oligamiq.github.io/rubrc/.rubrc-pages-build.json returned404.
- GitHub contents API for pages-dist returned404 No commit found for ref. Last three static deployment workflow runs all failed (29647321300,29600920970,29600806171). They cannot identify Cloudflare's currently served commit.
- Python urllib GET of public root returned403; no HTML artifact saved. No Cloudflare account/deployment API was inspected.

Thus exact public-vs-source diff is UNRESOLVED; do not label experimental off baseline as deployed public build.

## Established differences

Main integration from58a2d878 to8c012fc2 changed only verification assets/workflow/README. It did not import experimental runtime changes. Required check is enforced.

Main vs committed experimental branch inspected with git diff origin/main HEAD (selected raw diff saved as main-to-experiment.diff):
- sysroot transfer total timeout60s ->600s, inactivity60s; progress tracks compressed input and output.
- opt-in512MiB VFS initial heap build option; default remains unchanged.
- source-identical vendoring of am-fs-squashfs0.1.3 for reproducible dependency availability.
- startup/LSP/sysroot/memory instrumentation and build/benchmark automation.
- experimental external pinned WVL includes bounded read-lock batching, waiter-aware locking and reset fixes; these are NOT imported as application runtime changes into main. Batching default off.

Browser experimental A/B (not public comparison): semantic warming31.70->14.90s; total startup64.36->36.56s. Same hosted machine, specific workload, separately generated caches, not arbitrary hardware guarantee. See docs/results/memory-lock-batching-45131532216/REPORT.md.

Uncommitted local lsp_opt.wasm/vfs.js/worker.ts changes also exist and were not included in the committed-source comparison or main integration.

Procedure: gh run list --workflow static.yml; gh API deployments/contents; git logs; git diff origin/main HEAD -- selected runtime paths; web_fetch metadata URLs. No deployment or code modification performed during this comparison.
