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


# These inventories are the contract for WVL_REV, not inferred from run output.
SEMANTIC_COVERAGE = {
    'narrow_signed_mixed_guests': {'originalOperators': 14, 'comparisons': 491520},
    'wide_little_endian_live_stack': {'originalOperators': 13, 'comparisons': 458752},
    'bridge_arithmetic_truncation': {'originalOperators': 13, 'comparisons': 458752},
}
CORE_TESTS = {
    'overlapping_readers_notify_only_when_the_last_one_leaves',
    'parked_writer_is_woken_by_the_last_reader',
    'notification_before_actual_park_is_not_lost',
    'reader_count_aba_still_wakes_the_writer',
    'writer_release_broadcasts_to_a_reader', 'multiple_waiting_writers_complete',
    'spurious_wait_return_retries_acquisition',
    'readers_and_writers_preserve_exclusion_and_payload',
}
WAITER_TESTS = {'last_reader_leaves_before_writer_registration',
                'saturated_readers_do_not_overflow_the_marker'}
ACTUAL_CASES = {
    'legacy-writer_release_to_reader_payload': ('writer_release_to_reader_payload', 5, 1),
    'legacy-readers_release_to_writer_disjoint_payloads': ('readers_release_to_writer_disjoint_payloads', 840, 2),
    'waiter-aware-writer_release_to_reader_payload': ('writer_release_to_reader_payload', 5, 1),
    'waiter-aware-readers_release_to_writer_disjoint_payloads': ('readers_release_to_writer_disjoint_payloads', 1715, 2),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inventory(rows, key, expected):
    names = [key(row) for row in rows]
    require(len(names) == len(expected) and set(names) == set(expected), 'unexpected or duplicate inventory')


def validate_batch_model(report):
    require(report['passed'] is True and report['coverage'] == {'cases':997, 'states':52810, 'edges':87420}, 'batch model coverage')
    controls = report['negativeControls']
    require(set(controls) == {'omit_acquire', 'hold_boundary', 'writer_ignores_readers', 'stale_base', 'late_bound', 'early_release'}
            and all(x['passed'] is False for x in controls.values()), 'batch model controls')
    return True


def validate_protocol(report):
    scenarios = {('R',(2,)), ('W',(2,)), ('RW',(1,1)), ('RRW',(1,1,1)),
                 ('RWW',(1,1,1)), ('RRWW',(1,1,1,1)), ('RW',(2,2)),
                 ('RRW',(2,1,1)), ('RWW',(2,1,1)), ('RRRRW',(1,1,1,1,1))}
    require(report['passed'] is True, 'protocol outcome')
    inventory(report['cases'], lambda x: (x['roles'], tuple(x['operations']), x['waiterAware']),
              {(roles, ops, aware) for roles, ops in scenarios for aware in (False, True)})
    require(all(type(x['waiterAware']) is bool and x['passed'] is True and x['terminalStates'] > 0
                and x['states'] == x['statesWithPathToCompletion'] > 0 for x in report['cases']), 'protocol reachability')
    controls = report['negativeControls']
    require(set(controls) == {'split_wait', 'mark_store', 'omit_reader_notify', 'writer_notify_one', 'ignore_acquire_comparison', 'omit_saturation'}
            and all(x['passed'] is False for x in controls.values()), 'protocol controls')
    return True


def validate_semantic(report):
    require(report['passed'] is True and report['targetRevision'] == WVL_REV, 'semantic provenance/outcome')
    require(report['comparisons'] == 1409024 and report['referenceInputs'] == 24576
            and report['candidateRunsWithAcquisitionElision'] == 704512, 'semantic counts')
    require(report['coverage'] == SEMANTIC_COVERAGE, 'semantic program coverage')
    controls = report['negativeControls']
    require(set(controls) == {'stale_base', 'reverse_store_operands'}
            and all(x['detected'] is True for x in controls.values()), 'semantic controls')
    return True


def smt_inventory():
    expected = {}
    for bits in (32, 64):
        for width in ((1, 2, 4) if bits == 32 else (1, 2, 4, 8)):
            tag = f'i{bits}_{width}bytes'
            expected[tag + '_load_u'] = 'unsat'
            if width * 8 < bits:
                expected[tag + '_load_s'] = 'unsat'
            expected[tag + '_store_projection'] = 'unsat'
            if width == 1:
                expected[tag + '_mutant_signed_unsigned'] = 'sat'
    expected.update(i32_address_plus_memarg='unsat', store_spill_restore_stack='unsat', mutant_store_spill_swap='sat')
    return expected


def validate_smt(report):
    expected = smt_inventory()
    require(report['passed'] is True, 'SMT outcome')
    inventory(report['queries'], lambda x: x['name'], expected)
    require(all(x['expected'] == expected[x['name']] == x['result'] for x in report['queries']), 'SMT outcomes')
    return True


def validate_correspondence(report):
    names = {f'bridge-gap-{n}' for n in (0, 59, 60, 61, 62, 63, 64, 65, 126, 127, 128)}
    names |= {f'scalar-run-{n}' for n in (1, 2, 21, 22, 23, 63, 64, 65, 129)}
    names |= {f'barrier-{n}' for n in range(12)} | {'all23-scalars-mixed-guests'}
    require(report['passed'] is True and report['validatedOutputs'] == 66 and report['scalarKinds'] == 23, 'correspondence counts')
    inventory(report['cases'], lambda x: (x['case'], x['batching']), {(name, mode) for name in names for mode in (False, True)})
    require(all(type(x['batching']) is bool and x['eventCount'] > 0 and x['acquisitions'] > 0 for x in report['cases']), 'correspondence nonvacuity')
    controls = report['eventMutationControls']
    require(set(controls) == {'omitBase', 'omitRelease', 'wrongGuestBase'}
            and all(x is True for x in controls.values()), 'correspondence controls')
    return True


def validate_native(report, repetitions=2):
    require(report['observed_commit'] == WVL_REV and report['sources_unchanged'] is True
            and report['source_hashes_before'] == report['source_hashes_after']
            and not report['failures'], 'native provenance/outcome')
    expected = {f'{harness}-{mode}-opt{opt}' for harness in ('core', 'exports')
                for mode in ('baseline', 'waiter') for opt in (0, 3)}
    inventory(report['variants'], lambda x: x['label'], expected)
    require(report['commands'] and all(x['returncode'] == 0 and not x['timed_out'] for x in report['commands']), 'native commands')
    for variant in report['variants']:
        harness, mode, optimization = variant['label'].split('-')
        prefix = 'memory_lock::tests::' if harness == 'core' else 'original_lock::memory_lock::tests::'
        names = {prefix + name for name in CORE_TESTS | (WAITER_TESTS if mode == 'waiter' else set())}
        if harness == 'exports':
            names.add('uncontended_readers_notify_only_in_baseline')
        require(variant['harness'] == harness and variant['feature_enabled'] is (mode == 'waiter')
                and variant['optimization'] == int(optimization[3:]), 'native variant identity')
        inventory(variant['test_names'], lambda x: x, names)
        require(variant['expected_test_count'] == len(names), 'native expected count')
        inventory(variant['runs'], lambda x: x['repetition'], set(range(1, repetitions + 1)))
        require(all(x['passed'] is True and x['passed_test_count'] == len(names)
                    and x['test_threads'] == (1 if x['repetition'] % 2 else 4)
                    for x in variant['runs']), 'native run counts')
    require(report['summary'] == {'variant_count': 8, 'test_process_runs': 8 * repetitions,
            'successful_test_process_runs': 8 * repetitions, 'successful_test_executions': 76 * repetitions,
            'timeout_count': 0, 'outcome': 'PASS'}, 'native totals')
    return True


def validate_litmus(report):
    names = {'direct', 'direct_no_release', 'direct_no_acquire', 'marker_rmw', 'marker_store'}
    require(report['passed'] is True, 'litmus outcome')
    inventory(report['commands'], lambda x: x['name'], names | {'build'})
    for row in report['commands']:
        require(row['exitCode'] == 0 and not row.get('timedOut'), 'litmus command failed')
        if row['name'] == 'build':
            continue
        result = row['result']
        mutant = row['name'] not in {'direct', 'marker_rmw'}
        require(result['scenario'] == row['name'] and result['mutation'] is mutant
                and result['expectedOutcomeObserved'] is True and result['successfulAcquisitionObservations'] > 0
                and result['modelExecutionsStarted'] > 0, 'litmus identity/coverage')
        require(('STALE_PAYLOAD' in (result['panic'] or '')) if mutant else result['panic'] is None, 'litmus control outcome')
    return True


def validate_actual(report, logs):
    expected = set(ACTUAL_CASES) | {'rustc-version', 'cargo-version', 'source-commit', 'source-status', 'legacy-build', 'waiter-aware-build'}
    inventory(report['commands'], lambda x: x['label'], expected)
    require(set(logs) == expected and report['all_invocations_passed'] is True, 'actual command/log inventory')
    require(all(x['exit_code'] == 0 and not x['timed_out'] for x in report['commands']), 'actual commands')
    require(report['source']['source_sha256'] == 'd9c08f4561376fbe356d67ca8451e99fcdb9c79c29d78bbf7bb82a651a896961'
            and report['source']['instrumented_sha256'] == 'dd97b92d0feba42220492da94c3a3246f9a3337b4366db95b4f33cd9e60fc1c9', 'actual source hash')
    require(report['limits']['max_permutations'] == 10000 and report['limits']['max_duration'] == 30, 'actual bounds')
    for label, log in logs.items():
        counters = re.findall(r'^MODEL_RESULT case=(\S+) executions_started=(\d+) executions_completed=(\d+) payload_assertions_per_execution=(\d+) elapsed_ms=\d+ status=bounded_model_pass_not_arbitrary_exhaustiveness$', log, re.M)
        if label not in ACTUAL_CASES:
            require(not counters, 'unexpected actual model output')
            continue
        case, count, assertions = ACTUAL_CASES[label]
        require(counters == [(case, str(count), str(count), str(assertions))], 'actual identity/coverage')
        summaries = re.findall(r'^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;', log, re.M)
        require(summaries == [('1', '0', '0', '0', '1')], 'actual Rust test count')
        require(f'test tests::{case} ... ' in log, 'actual Rust test identity')
    return True


def validate_wasm(report, structural, runtime):
    require(report['status'] == 'pass' and report['source_commit'] == WVL_REV and not report['source_status'] and not report['source_status_after'], 'Wasm source/outcome')
    require(Path(report['source_root']).resolve()==(ROOT/'.worktrees/wvl-lock-batching').resolve(), 'Wasm source root')
    expected_sources={'abi.rs'} | {'wasm_stream/'+p+'.rs' for p in ('pipeline','translator','mem_info','own_memory_abi','passes/post_combine','passes/fn_in_starts','passes/reactor_initialize')}
    require(set(report['source_sha256'])==expected_sources and report['source_sha256']==report['source_sha256_after'], 'Wasm source hashes')
    expected_commands = {'source-version','source-status','version-cargo','version-rustc','version-node','build','structural','workers','source-status-after'}
    inventory(report['commands'], lambda x:x['label'], expected_commands)
    require(all(x['exit_code']==0 and not x.get('timed_out',False) for x in report['commands']), 'Wasm subprocesses')
    require(structural['status']=='pass' and structural['negative_controls']=={'wrong_timeout_type_rejected':True}, 'Wasm structural controls')
    inventory(structural['cases'], lambda x:x['threads'], {False,True})
    require(all(type(x['threads']) is bool for x in structural['cases']), 'Wasm thread modes')
    require(runtime['status']=='pass', 'Wasm runtime outcome')
    inventory(runtime['cases'],lambda x:x['name'],{'notify-one','notify-all-u32-max'})
    for case in runtime['cases']:
        size, count = (1,1) if case['name']=='notify-one' else (3,-1)
        require(case['status']=='pass' and case['workers']==size and case['notifyCount']==count, 'Wasm cohort identity')
        require(case['parkedWitness']=={'singleNotifyReturn':size,'requestedCount':count}, 'Wasm parked witness')
        inventory(case['events'],lambda x:(x['type'],x['id']),{(kind,i) for kind in ('ready','done') for i in range(size)})
        for event in case['events']:
            require((event['mismatch']==1 and event['zeroTimeout']==2) if event['type']=='ready' else (event['result']==0 and event['wakes']>0), 'Wasm wait result')
    return True


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
        command('validator-unit-tests',[py,'-m','unittest','discover','-s','verification','-p','test_run_checks.py','-v'])
        batching=ROOT/'verification/memory-lock-batching'
        command('batch-model',[py,batching/'model_check.py','--output',out/'batch-model.json'])
        r=load(out/'batch-model.json')
        validate('batch model 997 cases and six detected mutants',validate_batch_model(r))
        command('semantic',[py,batching/'semantic_check.py','--output',out/'semantic.json'])
        r=load(out/'semantic.json')
        validate('semantic full recorded domain',validate_semantic(r))
        command('smt',[py,batching/'smt_check.py','--output-dir',out/'smt'])
        r=load(out/'smt/results.json')
        validate('SMT all24 expected outcomes',validate_smt(r))
        command('protocol',[py,ROOT/'verification/memory-lock-protocol/protocol_check.py','--output',out/'protocol.json'])
        r=load(out/'protocol.json')
        validate('protocol20 scenarios complete reachability six mutants',validate_protocol(r))
        command('native',[py,ROOT/'verification/memory-lock-protocol/native_regression.py','--output-dir',out/'native','--repetitions','2'])
        r=load(out/'native/native-results.json')
        validate('native exact inventories and all152 tests successful',validate_native(r))
        manifests=[('correspondence',batching/'stage3-harness/Cargo.toml','stage3-cargo'),
                   ('litmus',ROOT/'verification/memory-lock-ordering/litmus-harness/Cargo.toml','ordering-litmus')]
        for name, manifest, target in manifests:
            command(name+'-prepare',['cargo','build','--locked','--manifest-path',manifest],600,{'CARGO_TARGET_DIR':str(ROOT/'target/verification-tools'/target)})
        prefix='ci-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')
        command('correspondence',[py,batching/'run_correspondence.py',prefix])
        r=load(batching/(prefix+'.json'))
        validate('actual emitter66 outputs23 scalars',validate_correspondence(r))
        summary['correspondenceArtifact']=str((batching/(prefix+'.json')).relative_to(ROOT))
        # Copy fresh artifacts into the CI bundle; do not remove originals.
        for suffix in ('.json','.stdout.log','.stderr.log'):
            (out/('correspondence'+suffix)).write_bytes((batching/(prefix+suffix)).read_bytes())
        ordering=ROOT/'verification/memory-lock-ordering'
        command('litmus',[py,ordering/'run_litmus.py','--output-dir',out/'litmus'],300)
        r=load(out/'litmus/results.json')
        validate('Loom five expected nonvacuous cases',validate_litmus(r))
        # This runner deliberately has a separate Cargo home; prepare both feature
        # builds there with a cold-cache budget before its short test deadlines.
        harness=ordering/'actual-harness'
        actual_env={'CARGO_HOME':str(harness/'.cargo-home'), 'CARGO_TARGET_DIR':str(harness/'target')}
        for mode, features in [('legacy', []), ('waiter-aware', ['--features','waiter-aware-memory-lock'])]:
            command('actual-'+mode+'-prepare',['cargo','test','--locked','--no-run','--manifest-path',harness/'Cargo.toml',*features],600,actual_env)
        text=command('actual-loom',[py,ordering/'actual_runner.py','--max-permutations','10000','--max-duration','30','--test-timeout','60'],600)
        matches=re.findall(r'^RESULTS (.+)$',text,re.M)
        validate('actual Loom exactly one result directory',len(matches)==1)
        actual=Path(matches[0]);r=load(actual/'summary.json')
        logs={record['label']:(ordering/record['log']).read_text() for record in r['commands']}
        validate('actual Loom exact identities test counts hashes and expanded coverage',validate_actual(r,logs))
        summary['actualLoomArtifact']=str(actual.relative_to(ROOT))
        import shutil
        shutil.copytree(actual,out/'actual-loom')
        if not args.skip_wasm:
            command('wasm',[py,ROOT/'verification/memory-lock-wasm/run.py','--output-dir',out/'wasm','--source-root',source],600)
            validate('actual Wasm lowering and parked-worker witnesses', validate_wasm(load(out/'wasm/result.json'),load(out/'wasm/structural.json'),load(out/'wasm/runtime.json')))
        final_rev=command('source-revision-after',['git','-C',source,'rev-parse','HEAD']).strip()
        final_clean=command('source-status-after',['git','-C',source,'status','--porcelain','--untracked-files=no']).strip()
        validate('production checkout remains pinned and clean',final_rev==WVL_REV and not final_clean)
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
