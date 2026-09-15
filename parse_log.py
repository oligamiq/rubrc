import sys
import re

with open('/home/oligami/.local/share/opencode/tool-output/tool_fa14a4cad00152oZxkP2WRpNoo') as f:
    lines = f.readlines()

def search(name, pattern, max_len=None):
    print(f"\n--- {name} ---")
    count = 0
    for i, l in enumerate(lines):
        if re.search(pattern, l):
            if max_len is None or len(l) < max_len:
                print(f"{i+1}: {l.strip()[:200]}")
                count += 1
    print(f"Total: {count}")

search("Test stages/outcome", r"(?i)browser readiness failed|waiting failed|test")
search("cargo:_main", r"cargo:_main")
search("rustc:_main", r"rustc:_main")
search("wasi-ext-spawn", r"wasi-ext-spawn")
search("rust-analyzer progress", r"rust-analyzer.*progress")
search("Sysroot/rust-src boundaries", r"(?i)(sysroot|rust-src).*(start|done|fetch|ready)")
search("Diagnostics / Markers", r"(?i)diagnostic|marker", max_len=300)
search("Browser errors", r"Error:|Exception:|browser readiness failed", max_len=300)
search("Last meaningful boundary", r"wasi_thread_start|sysrootGetNextFileMeta")
search("Times/Timeout/249s", r"(?i)timeout|249|time:|elapsed")

