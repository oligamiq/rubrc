#!/usr/bin/env python3
"""Reproduce pinned Loom litmus exploration; preserve outputs on success/failure."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SCENARIOS = ['direct','direct_no_release','direct_no_acquire','marker_rmw','marker_store']
p = argparse.ArgumentParser()
p.add_argument('--output-dir', type=Path, required=True)
p.add_argument('--timeout', type=int, default=180)
a = p.parse_args()
out = a.output_dir.resolve()
out.mkdir(parents=True, exist_ok=False)
env = dict(os.environ, CARGO_TARGET_DIR=str(ROOT/'target/verification-tools/ordering-litmus'))
report = {'dateUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'platform':platform.platform(), 'python':platform.python_version(),
          'loom':'0.7.2', 'commands':[], 'passed':False}
def run(name, cmd):
    row = {'name':name,'command':cmd,'timeoutSeconds':a.timeout}
    try:
        r = subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,timeout=a.timeout)
        stdout,stderr=r.stdout,r.stderr
        row['exitCode']=r.returncode
    except subprocess.TimeoutExpired as e:
        stdout,stderr=e.stdout or b'',e.stderr or b''
        row['exitCode']=None
        row['timedOut']=True
    for label,data in [('stdout',stdout),('stderr',stderr)]:
        path=out/(name+'.'+label+'.log');path.write_bytes(data)
        row[label]={'file':path.name,'sha256':hashlib.sha256(data).hexdigest()}
    report['commands'].append(row)
    return row,stdout
try:
    row,_=run('build',['cargo','build','--offline','--locked','--manifest-path','verification/memory-lock-ordering/litmus-harness/Cargo.toml'])
    if row['exitCode'] != 0: raise RuntimeError('build failed; inspect raw logs')
    report['rustc']=subprocess.check_output(['rustc','-vV'],text=True)
    for name in SCENARIOS:
        row,stdout=run(name,[str(ROOT/'target/verification-tools/ordering-litmus/debug/wvl-memory-ordering-litmus'),name])
        if stdout:
            row['result']=json.loads(stdout)
        if row['exitCode'] != 0 or not row.get('result',{}).get('expectedOutcomeObserved'):
            raise RuntimeError('unexpected outcome: '+name)
    report['passed']=True
finally:
    paths=[ROOT/'verification/memory-lock-ordering/litmus-harness'/f for f in ['Cargo.toml','Cargo.lock','src/main.rs']]
    paths.append(Path(__file__).resolve())
    report['sourceSha256']={str(f.relative_to(ROOT)):hashlib.sha256(f.read_bytes()).hexdigest() for f in paths}
    (out/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
