# First reconstructed frontend comparison failed before candidate

Run45960165266 atb86ff9fb,2026-11-27. Core restore and both frontend builds passed. FIRST feature-OFF cold startup never reached ready within300s. No ON measurement, no efficacy comparison. Browser Chrome150.0.7871.24 differs from previous diagnostic Chrome157; record, don't pool timings. Artifact result had no pageerrors, but initial runner did not retain general console/failure screenshot.

Parent reconstruction audit found retained preview includes v1/ sysroot/tool assets but prepare_frontend_pair copied only rust-src/cache/compressed core. Reconstructed output omitted v1/. This is a concrete incomplete preview assembly bug; its exact causal contribution cannot be proven from sparse first-run logs. Fix copy v1 recursively and retain console/request failure state/screenshots on future failure. Do not blame default-off application/RA changes for this run.

Next run same source pair/settings plus assembly fix and better diagnostics; no production deployment. All original failed evidence retained.
