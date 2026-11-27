# Local checkout integrity incident

2026-11-27 JST. Command: `git worktree add --detach .worktrees/startup-frontend-comparison 2635f7fe` failed exit128:

```
error: inflate: data stream error (incorrect data check)
fatal: packed object 1c8acef7db1d8ea6a8aa7dc6dfa1abd5e1de68cc (stored in /home/oligami/projects/rubrc/.git/objects/pack/pack-7066b815a77bce5449c1e77a547fb11ae29b6399.pack) is corrupt
```

No objects or existing changes deleted/replaced. Cause unknown. Do not trust local full-checkout reconstruction until verified. Remote hosted source2635f7fe was fetched and diagnostic run45958190399 succeeded. Use independent remote shallow checkout/hosted frontend build rather than attempt destructive local repository repair. Partial worktree may remain; do not reuse without inspecting.
