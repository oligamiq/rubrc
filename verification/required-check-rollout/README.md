# Main required memory-lock gate rollout

Date: 2026-11-26 JST. User authorized main integration and required-check configuration, conditional on README documenting that the deployed public page and main use different commits.

## Scope

- Isolated integration worktree: `.worktrees/main-required-verification`, branch `ci/required-lock-verification` based on remote main `58a2d87836a1bcb46bafaecf4d03ca78e45db88c`.
- Imported only `verification/` and memory-lock workflow from `ca5e800d`, plus README notice. No experimental application/runtime changes.
- `git diff ca5e800d -- verification --exit-code` passed: historical evidence preserved byte-for-byte. General diff whitespace check reported historical raw-log whitespace; these logs were not rewritten. Targeted README/workflow whitespace check passed.
-20 validator tests passed. YAML trigger/name/permission assertions passed.
- PR: https://github.com/oligamiq/rubrc/pull/11
- New unique job name: `Memory lock verification gate`, GitHub Actions app15368. Trigger every main PR (no path filters), main push, merge-group, manual dispatch.
- Before change: main branch protection GET returned404 Branch not protected; repository rulesets were empty.
- Existing GitHub Pages workflow is manual-dispatch only. Production split workflow pushes only develop. No deploy was requested or started by this rollout. README live demo points to rubrc.pages.dev; no Cloudflare deployment API was inspected, so no exact live demo SHA is claimed.

## Procedure / pending verification

1. Wait for PR11 CI success.
2. Merge scoped PR into main using normal GitHub merge; observe main push check.
3. Configure required status check with exact context/app, strict up-to-date checks, enforce for admins, no force pushes/deletions. Do not add mandatory review approvals or other unrelated requirements.
4. Read back branch protection and save exact JSON. Record merge/run links and outcomes.

## Observed rollout

- PR11 latest-head run45800125600 passed in1m35s; merged normally with exact-head guard. Merge commit: `8c012fc2db16782271a8b91def1ccca8d117b057`.
- Main content validation confirms only verification assets/workflow/README differ from previous main; Japanese public/main revision notice present. No production changes.
- PUT branch protection succeeded; independent GET confirms strict required context `Memory lock verification gate`, GitHub Actions app15368, admins enforced, force pushes/deletion disabled. No review-approval requirement added. See protection-request/response/readback JSON.
- GitHub Pages last deployment run before/after is identical. This checks GitHub Pages only; no claim about external Cloudflare activity by others.
- Main push [run45800564183](https://github.com/oligamiq/rubrc/actions/runs/45800564183) passed in1m34s. API confirms exact required context and GitHub Actions app15368 report success at the main merge commit. Rollout complete. Existing action Node20 declaration warnings are nonfatal; platform runs actions on Node24.

Commands: `gh pr merge 11 --merge --match-head-commit 89844cc914566fbbc639aa737344041bad1c8555`; `gh api --method PUT repos/oligamiq/rubrc/branches/main/protection --input verification/required-check-rollout/protection-request.json`; subsequent GET and JSON assertions. No bypass/admin-merge flag used. Raw responses accompany this file.
