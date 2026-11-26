#!/usr/bin/env python3
"""Run scoped lock verification gates; preserve logs and fail closed on any error."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
WVL_REV = '77f45543eb976e4e7843e78fcd67bd837acac6bd'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--skip-wasm', action='store_true', help='Development only: result is explicitly partial')
    args = parser.parse_args()
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=False)
    env = {k:v for k,v in os.environ.items() if not k.startswith('LOOM_')}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    source = ROOT/'.worktrees/wvl-lock-batching'
    summary = {'startedAt':datetime.now(timezone.utc).isoformat(), 'passed':False,
               'scope':'finite/model-bounded regression gates, not whole-program proof',
               'partial':args.skip_wasm, 'commands':[],'validations':[]}
    def save():
        (out/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    def command(name, argv, timeout=180, extra=None):
        record={'name':name,'argv':[str(x) for x in argv],'timeoutSeconds':timeout}
        summary['commands'].append(record)
        start=time.monotonic()
        with (out/(name+'.stdout.log')).open('xb') as stdout, (out/(name+'.stderr.log')).open('xb') as stderr:
            process=subprocess.Popen(record['argv'],cwd=ROOT,env=env | (extra or {}),stdout=stdout,stderr=stderr,start_new_session=True)
            try: code=process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL);code=process.wait();record['timedOut']=True
            record['exitCode']=code
        record['elapsedSeconds']=time.monotonic()-start
        for stream in ('stdout','stderr'):
            path=out/(name+'.'+stream+'.log')
            record[stream]={'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
        save()
        if code != 0 or record.get('timedOut'): raise RuntimeError(name+' failed; see logs')
        print(name+': PASS',flush=True)
        return (out/(name+'.stdout.log')).read_text()
    def validate(name, condition):
        if not condition: raise RuntimeError('validation failed: '+name)
        summary['validations'].append(name)
        save()
    def load(path): return json.loads(path.read_text())
    try:
        rev=command('source-revision',['git','-C',source,'rev-parse','HEAD']).strip()
        validate('pinned WVL revision',rev==WVL_REV)
        clean=command('source-status',['git','-C',source,'status','--porcelain','--untracked-files=no']).strip()
        validate('production checkout clean',not clean)
        summary['targetRevision']=rev
        summary['rubrcRevision']=command('rubrc-revision',['git','rev-parse','HEAD']).strip()
        command('python-version',[sys.executable,'--version'])
        command('rustc-version',['rustc','-vV'])
        command('node-version',['node','--version'])
        py=sys.executable
        batching=ROOT/'verification/memory-lock-batching'
        command('batch-model',[py,batching/'model_check.py','--output',out/'batch-model.json'])
        r=load(out/'batch-model.json')
        validate('batch model 997 cases and six detected mutants',r['passed'] and r['coverage']['cases']==997 and len(r['negativeControls'])==6 and all(not c['passed'] for c in r['negativeControls'].values()))
        command('semantic',[py,batching/'semantic_check.py','--output',out/'semantic.json'])
        r=load(out/'semantic.json')
        validate('semantic full recorded domain',r['passed'] and r['comparisons']==1409024 and all(x['detected'] for x in r['negativeControls'].values()))
        command('smt',[py,batching/'smt_check.py','--output-dir',out/'smt'])
        r=load(out/'smt/results.json')
        validate('SMT all24 expected outcomes',r['passed'] and len(r['queries'])==24 and all(x['result']==x['expected'] for x in r['queries']))
        command('protocol',[py,ROOT/'verification/memory-lock-protocol/protocol_check.py','--output',out/'protocol.json'])
        r=load(out/'protocol.json')
        validate('protocol20 scenarios complete reachability six mutants',r['passed'] and len(r['cases'])==20 and all(x['states']==x['statesWithPathToCompletion'] for x in r['cases']) and len(r['negativeControls'])==6 and all(not x['passed'] for x in r['negativeControls'].values()))
        command('native',[py,ROOT/'verification/memory-lock-protocol/native_regression.py','--output-dir',out/'native','--repetitions','2'])
        r=load(out/'native/native-results.json')
        validate('native all subprocesses successful',all(x['returncode']==0 and not x['timed_out'] for x in r['commands']) and len(r['variants'])==8)
        manifests=[('correspondence',batching/'stage3-harness/Cargo.toml','stage3-cargo'),
                   ('litmus',ROOT/'verification/memory-lock-ordering/litmus-harness/Cargo.toml','ordering-litmus')]
        for name, manifest, target in manifests:
            command(name+'-prepare',['cargo','build','--locked','--manifest-path',manifest],600,{'CARGO_TARGET_DIR':str(ROOT/'target/verification-tools'/target)})
        prefix='ci-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')
        command('correspondence',[py,batching/'run_correspondence.py',prefix])
        r=load(batching/(prefix+'.json'))
        validate('actual emitter66 outputs23 scalars',r['passed'] and r['validatedOutputs']==66 and r['scalarKinds']==23 and len(r['cases'])==66 and all(r['eventMutationControls'].values()))
        summary['correspondenceArtifact']=str((batching/(prefix+'.json')).relative_to(ROOT))
        # Copy fresh artifacts into the CI bundle; do not remove originals.
        for suffix in ('.json','.stdout.log','.stderr.log'):
            (out/('correspondence'+suffix)).write_bytes((batching/(prefix+suffix)).read_bytes())
        ordering=ROOT/'verification/memory-lock-ordering'
        command('litmus',[py,ordering/'run_litmus.py','--output-dir',out/'litmus'],300)
        r=load(out/'litmus/results.json')
        cases=[x['result'] for x in r['commands'] if 'result' in x]
        validate('Loom five expected nonvacuous cases',r['passed'] and len(cases)==5 and all(x['expectedOutcomeObserved'] and x['successfulAcquisitionObservations']>0 for x in cases))
        text=command('actual-loom',[py,ordering/'actual_runner.py','--max-permutations','10000','--max-duration','30','--test-timeout','60'],600)
        matches=re.findall(r'^RESULTS (.+)$',text,re.M)
        validate('actual Loom exactly one result directory',len(matches)==1)
        actual=Path(matches[0]);r=load(actual/'summary.json')
        validate('actual Loom metadata and tests successful',r['all_invocations_passed'] and all(x['exit_code']==0 and not x['timed_out'] for x in r['commands']))
        counters=[]
        for record in r['commands']:
            log=(ordering/record['log']).read_text()
            counters+=re.findall(r'MODEL_RESULT case=(\S+) executions_started=(\d+) executions_completed=(\d+)',log)
        validate('actual Loom four nonzero completed cases',len(counters)==4 and all(int(a)>0 and a==b for _,a,b in counters))
        # Specific pinned model version must not silently end early due to duration cap.
        validate('actual Loom recorded expanded coverage',sorted(int(a) for _,a,_ in counters)==[5,5,840,1715])
        summary['actualLoomArtifact']=str(actual.relative_to(ROOT))
        import shutil
        shutil.copytree(actual,out/'actual-loom')
        if not args.skip_wasm:
            command('wasm',[py,ROOT/'verification/memory-lock-wasm/run.py','--output-dir',out/'wasm'],600)
            # Additional schema assertions are added with the backend runner contract.
        summary['passed']=True
    except Exception as error:
        summary['error']=repr(error)
        raise
    finally:
        summary['runnerSha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        summary['finishedAt']=datetime.now(timezone.utc).isoformat()
        save()
    return 0

if __name__=='__main__':
    raise SystemExit(main())
