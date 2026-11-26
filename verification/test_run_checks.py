#!/usr/bin/env python3
"""Fail-closed contract tests. No compiler, checkout, or old evidence required."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('run_checks', Path(__file__).with_name('run_checks.py'))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


def semantic():
    return {'passed': True, 'targetRevision': checks.WVL_REV, 'comparisons': 1409024,
            'referenceInputs': 24576, 'candidateRunsWithAcquisitionElision': 704512,
            'coverage': copy.deepcopy(checks.SEMANTIC_COVERAGE),
            'negativeControls': {n: {'detected': True} for n in ('stale_base', 'reverse_store_operands')}}


def actual():
    labels = set(checks.ACTUAL_CASES) | {'rustc-version', 'cargo-version', 'source-commit', 'source-status', 'legacy-build', 'waiter-aware-build'}
    report = {'commands': [{'label': n, 'exit_code': 0, 'timed_out': False} for n in sorted(labels)],
              'all_invocations_passed': True,
              'source': {'source_sha256': 'd9c08f4561376fbe356d67ca8451e99fcdb9c79c29d78bbf7bb82a651a896961',
                         'instrumented_sha256': 'dd97b92d0feba42220492da94c3a3246f9a3337b4366db95b4f33cd9e60fc1c9'},
              'limits': {'max_permutations': 10000, 'max_duration': 30}}
    logs = dict.fromkeys(labels, '')
    for label, (case, count, assertions) in checks.ACTUAL_CASES.items():
        logs[label] = (f'test tests::{case} ... MODEL case={case}\n'
                       f'MODEL_RESULT case={case} executions_started={count} executions_completed={count} '
                       f'payload_assertions_per_execution={assertions} elapsed_ms=1 status=bounded_model_pass_not_arbitrary_exhaustiveness\n'
                       'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.01s\n')
    return report, logs


def wasm():
    report = {'status':'pass','source_commit':checks.WVL_REV,'source_status':'','source_status_after':'',
              'source_root':str(checks.ROOT/'.worktrees/wvl-lock-batching'),
              'source_sha256':{p:'a'*64 for p in ({'abi.rs'} | {'wasm_stream/'+p+'.rs' for p in ('pipeline','translator','mem_info','own_memory_abi','passes/post_combine','passes/fn_in_starts','passes/reactor_initialize')})},
              'commands':[{'label':x,'exit_code':0} for x in ('source-version','source-status','version-cargo','version-rustc','version-node','build','structural','workers','source-status-after')]}
    report['source_sha256_after']=copy.deepcopy(report['source_sha256'])
    structural = {'status':'pass','cases':[{'threads':True},{'threads':False}],
                  'negative_controls':{'wrong_timeout_type_rejected':True}}
    runtime = {'status':'pass','cases':[]}
    for name,size,count in [('notify-one',1,1),('notify-all-u32-max',3,-1)]:
        events=[{'type':'ready','id':i,'mismatch':1,'zeroTimeout':2} for i in range(size)]
        events += [{'type':'done','id':i,'result':0,'wakes':1} for i in range(size)]
        runtime['cases'].append({'name':name,'workers':size,'notifyCount':count,'status':'pass','events':events,
            'parkedWitness':{'singleNotifyReturn':size,'requestedCount':count}})
    return report,structural,runtime


class Contracts(unittest.TestCase):
    def test_wasm_valid(self):
        self.assertTrue(checks.validate_wasm(*wasm()))

    def test_wasm_no_parked_witness(self):
        r,s,t=wasm();t['cases'][1]['parkedWitness']['singleNotifyReturn']=0
        with self.assertRaises(ValueError): checks.validate_wasm(r,s,t)

    def test_wasm_duplicate_ready_event(self):
        r,s,t=wasm();t['cases'][1]['events'][1]=t['cases'][1]['events'][0]
        with self.assertRaises(ValueError): checks.validate_wasm(r,s,t)

    def test_wasm_empty_controls(self):
        r,s,t=wasm();s['negative_controls']={}
        with self.assertRaises(ValueError): checks.validate_wasm(r,s,t)

    def test_semantic_valid(self):
        self.assertTrue(checks.validate_semantic(semantic()))

    def test_semantic_empty_controls(self):
        r = semantic(); r['negativeControls'] = {}
        with self.assertRaises(ValueError): checks.validate_semantic(r)

    def test_semantic_wrong_program(self):
        r = semantic(); r['coverage']['renamed'] = r['coverage'].pop('bridge_arithmetic_truncation')
        with self.assertRaises(ValueError): checks.validate_semantic(r)

    def test_semantic_truncated_count(self):
        r = semantic(); r['comparisons'] -= 1
        with self.assertRaises(ValueError): checks.validate_semantic(r)

    def test_smt_valid(self):
        r = {'passed': True, 'queries': [{'name': n, 'expected': e, 'result': e} for n, e in checks.smt_inventory().items()]}
        self.assertEqual(len(r['queries']), 24)
        self.assertTrue(checks.validate_smt(r))

    def test_smt_forged_expected_unknown(self):
        r = {'passed': True, 'queries': [{'name': n, 'expected': e, 'result': e} for n, e in checks.smt_inventory().items()]}
        r['queries'][0].update(expected='unknown', result='unknown')
        with self.assertRaises(ValueError): checks.validate_smt(r)

    def test_smt_duplicate_identity(self):
        r = {'passed': True, 'queries': [{'name': n, 'expected': e, 'result': e} for n, e in checks.smt_inventory().items()]}
        r['queries'][0] = r['queries'][1]
        with self.assertRaises(ValueError): checks.validate_smt(r)

    def test_correspondence_empty_controls(self):
        names = ([f'bridge-gap-{n}' for n in (0,59,60,61,62,63,64,65,126,127,128)]
                 + [f'scalar-run-{n}' for n in (1,2,21,22,23,63,64,65,129)]
                 + [f'barrier-{n}' for n in range(12)] + ['all23-scalars-mixed-guests'])
        r = {'passed': True, 'validatedOutputs': 66, 'scalarKinds': 23,
             'cases': [{'case': n, 'batching': b, 'eventCount': 1, 'acquisitions': 1} for n in names for b in (False, True)],
             'eventMutationControls': dict.fromkeys(('omitBase', 'omitRelease', 'wrongGuestBase'), True)}
        self.assertTrue(checks.validate_correspondence(r))
        r['eventMutationControls'] = {}
        with self.assertRaises(ValueError): checks.validate_correspondence(r)

    def test_actual_valid(self):
        self.assertTrue(checks.validate_actual(*actual()))

    def test_actual_swapped_feature_identity(self):
        r, logs = actual()
        a = 'legacy-readers_release_to_writer_disjoint_payloads'
        b = 'waiter-aware-readers_release_to_writer_disjoint_payloads'
        logs[a], logs[b] = logs[b], logs[a]
        with self.assertRaises(ValueError): checks.validate_actual(r, logs)

    def test_actual_truncated_but_successful_model(self):
        r, logs = actual()
        label = 'waiter-aware-readers_release_to_writer_disjoint_payloads'
        logs[label] = logs[label].replace('1715', '1000')
        with self.assertRaises(ValueError): checks.validate_actual(r, logs)

    def test_actual_zero_rust_tests(self):
        r, logs = actual(); label = next(iter(checks.ACTUAL_CASES))
        logs[label] = logs[label].replace('1 passed', '0 passed')
        with self.assertRaises(ValueError): checks.validate_actual(r, logs)

    def test_actual_duplicate_command(self):
        r, logs = actual(); r['commands'].append(r['commands'][0])
        with self.assertRaises(ValueError): checks.validate_actual(r, logs)

    def test_actual_wrong_source_hash(self):
        r, logs = actual(); r['source']['source_sha256'] = '0' * 64
        with self.assertRaises(ValueError): checks.validate_actual(r, logs)

    def test_native_empty_variants(self):
        r = {'observed_commit': checks.WVL_REV, 'sources_unchanged': True,
             'source_hashes_before': {}, 'source_hashes_after': {}, 'failures': [], 'variants': []}
        with self.assertRaises(ValueError): checks.validate_native(r)

    def test_litmus_wrong_identity(self):
        names = ('direct','direct_no_release','direct_no_acquire','marker_rmw','marker_store')
        r = {'passed': True, 'commands': [{'name': 'build', 'exitCode': 0}]}
        for n in names:
            mutant = n not in ('direct', 'marker_rmw')
            r['commands'].append({'name': n, 'exitCode': 0, 'result': {'scenario': n, 'mutation': mutant,
                'expectedOutcomeObserved': True, 'successfulAcquisitionObservations': 1,
                'modelExecutionsStarted': 1, 'panic': 'STALE_PAYLOAD' if mutant else None}})
        self.assertTrue(checks.validate_litmus(r))
        r['commands'][1]['result']['scenario'] = 'marker_rmw'
        with self.assertRaises(ValueError): checks.validate_litmus(r)


if __name__ == '__main__':
    unittest.main()
