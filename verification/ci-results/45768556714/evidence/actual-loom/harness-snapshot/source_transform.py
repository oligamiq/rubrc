#!/usr/bin/env python3
"""Exact, fail-closed instrumentation; called by Cargo build.rs and runner."""
import hashlib
import json
from pathlib import Path
import sys

SOURCE_SHA256 = "d9c08f4561376fbe356d67ca8451e99fcdb9c79c29d78bbf7bb82a651a896961"
REPLACEMENTS = [
    ("use core::sync::atomic::{AtomicI32, Ordering};", "use loom::sync::atomic::{AtomicI32, Ordering};"),
    ("pub(super) const fn new() -> Self {", "pub(super) fn new() -> Self {"),
    ('#[cfg(test)]\n#[path = "../tests/support/memory_lock_cases.rs"]\nmod tests;\n', ""),
]

def transform(source: Path, output: Path):
    raw = source.read_bytes()
    source_hash = hashlib.sha256(raw).hexdigest()
    if source_hash != SOURCE_SHA256:
        raise RuntimeError(f"source SHA256 mismatch: expected {SOURCE_SHA256}, got {source_hash}")
    text = raw.decode("utf-8")
    changes = []
    for old, new in REPLACEMENTS:
        count = text.count(old)
        if count != 1:
            raise RuntimeError(f"replacement must match exactly once, found {count}: {old!r}")
        text = text.replace(old, new)
        changes.append({"old": old, "new": new, "matches": count})
    output.mkdir(parents=True, exist_ok=True)
    adapted = text.encode("utf-8")
    (output / "memory_lock_instrumented.rs").write_bytes(adapted)
    manifest = {"source": str(source.resolve()), "source_sha256": source_hash,
                "instrumented_sha256": hashlib.sha256(adapted).hexdigest(),
                "replacements": changes}
    (output / "source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest

if __name__ == "__main__":
    transform(Path(sys.argv[1]), Path(sys.argv[2]))
