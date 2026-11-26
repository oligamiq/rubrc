#!/usr/bin/env python3
"""Recheck downloaded CI bundle contracts and digests; no test reexecution."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('checks', ROOT/'verification/run_checks.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, required=True, help='downloaded target/verification-ci directory')
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists(): raise SystemExit('Refusing to overwrite audit')
    bundle = args.bundle.resolve()
    count = 0
    def load(name): return json.loads((bundle/name).read_text())
    def digest(path, expected):
        nonlocal count
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        checks.require(actual == expected, 'digest mismatch: '+str(path))
        count += 1
    report={'passed':False,'bundle':str(bundle),'expectedSource':args.expected_sha,
            'scope':'Replay existing contracts and digest integrity, not new coverage'}
    try:
        summary=load('summary.json')
        checks.require(summary['passed'] is True and summary['partial'] is False, 'suite not complete')
        checks.require(summary['rubrcRevision']==args.expected_sha,'unexpected tested source')
        digest(ROOT/'verification/run_checks.py',summary['runnerSha256'])
        for row in summary['commands']:
            checks.require(row['exitCode']==0 and not row.get('timedOut'),'failed command')
            for stream in ('stdout','stderr'):
                digest(bundle/row[stream]['file'],row[stream]['sha256'])
        for function,name in [('validate_batch_model','batch-model.json'),('validate_semantic','semantic.json'),
                              ('validate_smt','smt/results.json'),('validate_protocol','protocol.json'),
                              ('validate_native','native/native-results.json'),('validate_correspondence','correspondence.json'),
                              ('validate_litmus','litmus/results.json')]:
            getattr(checks,function)(load(name))
        for row in load('native/native-results.json')['commands']:
            for stream in ('stdout','stderr'):
                digest(bundle/'native'/row[stream+'_path'],row[stream+'_sha256'])
        for row in load('litmus/results.json')['commands']:
            for stream in ('stdout','stderr'):
                digest(bundle/'litmus'/row[stream]['file'],row[stream]['sha256'])
        actual=load('actual-loom/summary.json')
        logs={r['label']:(bundle/'actual-loom'/Path(r['log']).name).read_text() for r in actual['commands']}
        checks.validate_actual(actual,logs)
        manifest=load('actual-loom/source/source-manifest.json')
        digest(bundle/'actual-loom/source/memory_lock_original.rs',manifest['source_sha256'])
        digest(bundle/'actual-loom/source/memory_lock_instrumented.rs',manifest['instrumented_sha256'])
        for name,expected in actual['harness_hashes'].items():
            suffix=Path(name).relative_to('actual-harness') if name.startswith('actual-harness/') else Path(name)
            digest(bundle/'actual-loom/harness-snapshot'/suffix,expected)
        wasm=load('wasm/result.json')
        report['recordedWasmSourceRoot']=wasm['source_root']
        # Only path changes across hosts; original JSON stays untouched.
        wasm['source_root']=str((ROOT/'.worktrees/wvl-lock-batching').resolve())
        checks.validate_wasm(wasm,load('wasm/structural.json'),load('wasm/runtime.json'))
        for name,expected in wasm['artifact_sha256'].items(): digest(bundle/'wasm'/name,expected)
        for item in load('smt/results.json')['queries']:
            digest(bundle/'smt'/(item['name']+'.smt2'),item['querySha256'])
        report.update(passed=True,gateValidatorsReplayed=9,digestsChecked=count,
                      runnerSha256=summary['runnerSha256'],pathNormalization='Only in-memory Wasm source_root rebased to local checkout')
    except Exception as error:
        report.update(error=repr(error),digestsChecked=count)
        raise
    finally:
        with args.output.open('x') as file: json.dump(report,file,indent=2);file.write('\n')
        print(json.dumps(report,indent=2))


if __name__=='__main__': main()
