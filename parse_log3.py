import sys
import re

with open('/home/oligami/.local/share/opencode/tool-output/tool_fa14a4cad00152oZxkP2WRpNoo') as f:
    lines = f.readlines()

def print_lines(name, pattern, max_len=None):
    print(f"\n--- {name} ---")
    for i, l in enumerate(lines):
        if re.search(pattern, l):
            if max_len is None or len(l) <= max_len:
                print(f"{i+1}: {l.strip()[:500]}")

print_lines("cargo", r"cargo:_main")
print_lines("rustc", r"rustc:_main")
print_lines("wasi-ext-spawn", r"wasi-ext-spawn")
print_lines("rust-analyzer", r"rust-analyzer.*progress")
print_lines("Sysroot fetch", r"Sysroot fetch start")
print_lines("sysrootGetNextFileMeta", r"sysrootGetNextFileMeta")
print_lines("marker", r"marker|diagnostic|hook")

