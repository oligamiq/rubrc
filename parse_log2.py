import sys
import re

with open('/home/oligami/.local/share/opencode/tool-output/tool_fa14a4cad00152oZxkP2WRpNoo') as f:
    lines = f.readlines()

def print_lines(pattern, max_len=None):
    for i, l in enumerate(lines):
        if re.search(pattern, l):
            if max_len is None or len(l) <= max_len:
                print(f"{i+1}: {l.strip()[:300]}")

print("Error Details:")
print_lines(r"(?i)Error: browser readiness failed|Waiting failed")

print("Timeout / 249 seconds:")
print_lines(r"249")
print_lines(r"300000")

