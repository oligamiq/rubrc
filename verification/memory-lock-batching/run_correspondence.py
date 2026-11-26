#!/usr/bin/env python3
"""Run actual-source harness, preserving raw logs and parsed evidence in NEW files."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'verification/memory-lock-batching'
CHECKOUT = ROOT / '.worktrees/wvl-lock-batching'
revision = subprocess.check_output(['git', '-C', str(CHECKOUT), 'rev-parse', 'HEAD'], text=True).strip()
if revision != '77f45543eb976e4e7843e78fcd67bd837acac6bd':
    raise SystemExit('Unexpected target revision: ' + revision)
prefix = sys.argv[1] if len(sys.argv) == 2 else 'stage3-reproduced'
if '/' in prefix or prefix in ('', '.', '..'):
    raise SystemExit('Output prefix must be a filename component')
paths = {key: OUT / (prefix + suffix) for key, suffix in
         [('stdout', '.stdout.log'), ('stderr', '.stderr.log'), ('result', '.json')]}
if any(path.exists() for path in paths.values()):
    raise SystemExit('Refusing to overwrite prior evidence')
cmd = ['cargo', 'run', '--offline', '--locked', '--manifest-path',
       'verification/memory-lock-batching/stage3-harness/Cargo.toml']
env = dict(os.environ, CARGO_TARGET_DIR=str(ROOT / 'target/verification-tools/stage3-cargo'))
run = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
for key, text in [('stdout', run.stdout), ('stderr', run.stderr)]:
    with paths[key].open('x') as file:
        file.write(text)
if run.returncode:
    raise SystemExit(run.returncode)
# Production pass prints import diagnostics to stdout. Accept ONLY its exact
# known lines before the JSON document; do not silently discard arbitrary output.
lines = run.stdout.splitlines()
allowed = {'SKIPPING IMPORT: env::__wasip1_vfs_own_memory_' + operation + '_' + guest
           for operation in ('size', 'grow') for guest in ('guest', 'other')}
while lines and lines[0] in allowed:
    lines.pop(0)
result = json.loads('\n'.join(lines))
if result.get('passed') is not True or result.get('validatedOutputs') != 66:
    raise SystemExit('Unexpected harness result')
base = CHECKOUT / 'wasi_virt_layer-cli/src/wasm_stream'
source_files = [base / (name + '.rs') for name in
                ('pipeline', 'translator', 'mem_info', 'own_memory_abi',
                 'passes/memory_lock_batching', 'passes/multi_memory_lowering')]
harness = OUT / 'stage3-harness'
source_files += [harness / name for name in ('Cargo.toml', 'Cargo.lock', 'build.rs', 'src/main.rs')]
source_files += [Path(__file__).resolve()]
result['provenance'] = {'targetRevision': revision, 'command': cmd,
    'CARGO_TARGET_DIR': env['CARGO_TARGET_DIR'], 'exitCode': run.returncode,
    'rustc': subprocess.check_output(['rustc', '--version'], text=True).strip(),
    'cargo': subprocess.check_output(['cargo', '--version'], text=True).strip(),
    'python': sys.version, 'platform': platform.platform(),
    'sourceSha256': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files},
    'stdout': str(paths['stdout'].relative_to(ROOT)), 'stderr': str(paths['stderr'].relative_to(ROOT))}
with paths['result'].open('x') as file:
    json.dump(result, file, indent=2)
    file.write('\n')
print(json.dumps({'passed': True, 'validatedOutputs': result['validatedOutputs'],
                  'scalarKinds': result['scalarKinds'], 'result': str(paths['result'].relative_to(ROOT))}))
