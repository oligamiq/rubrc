#!/usr/bin/env python3
"""Finite SC-atomic model of WVL RW lock, not a weak-memory Rust proof."""
import argparse
from collections import deque
import hashlib
import itertools
import json
from pathlib import Path
import platform
import time

# Small counter is deliberate: shrunk saturation domain, not actual 30-bit word.
MARK = 4
MAX_READERS = MARK - 1
# Thread = (PC, last observed word, remaining acquire/release operations).
# L load/loop, C weak acquire CAS, M mark CAS, Q compare-and-park,
# K broken split-park registration, P parked, H owns, N notify, D done.


def explore(roles, operations, aware=True, mutation='none'):
    initial = (0, tuple(('L', 0, n) for n in operations))
    queue = deque([initial])
    parents = {initial: None}
    transitions = terminal = cas_failures = mismatched_waits = 0
    def finish(t):
        return ('L', 0, t[2]-1) if t[2] > 1 else ('D', 0, 0)
    def trace(state, label):
        out = [label]
        while parents[state] is not None:
            old, action = parents[state]
            out.append(action)
            state = old
        return list(reversed(out))
    def failed(state, invariant):
        return {'passed': False, 'invariant': invariant, 'states': len(parents),
                'trace': trace(state, invariant)}
    while queue:
        state = queue.popleft()
        word, ts = state
        readers = sum(role == 'R' and t[0] == 'H' for role,t in zip(roles,ts))
        writers = sum(role == 'W' and t[0] == 'H' for role,t in zip(roles,ts))
        if writers > 1 or (writers and readers): return failed(state, 'exclusion')
        if writers:
            if word != -1: return failed(state, 'writer_word')
        elif word < 0 or (word & (MARK-1) if aware else word) != readers:
            return failed(state, 'reader_count')
        if aware and readers > MAX_READERS: return failed(state, 'counter_overflow')
        if all(t[0] == 'D' for t in ts):
            terminal += 1
            if word not in (0, MARK) if aware else word != 0:
                return failed(state, 'terminal_word')
            continue
        successors = []
        def emit(i, replacement, new_word, label, wakes=()):
            threads = list(ts)
            threads[i] = replacement
            for j in wakes: threads[j] = ('L', 0, ts[j][2])
            successors.append(((new_word, tuple(threads)), f'{i}{roles[i]}.{label}'))
        for i,(role,t) in enumerate(zip(roles,ts)):
            pc, seen, left = t
            if pc == 'L':
                if role == 'R':
                    if word < 0: emit(i, ('Q', word, left), word, 'load_writer')
                    elif aware and word & MAX_READERS == MAX_READERS:
                        emit(i, t, word, 'saturated_retry')
                    else: emit(i, ('C', word, left), word, 'load_reader_count')
                elif not aware:
                    if word == 0: emit(i, ('H', 0, left), -1, 'strong_acquire')
                    else: emit(i, ('Q', word, left), word, 'strong_cas_fail')
                elif word in (0, MARK): emit(i, ('C', word, left), word, 'load_free')
                elif word > 0 and not word & MARK: emit(i, ('M', word, left), word, 'load_need_mark')
                else: emit(i, ('Q', word, left), word, 'load_wait')
            elif pc == 'C':
                # weak CAS may fail spuriously, even with equal comparison.
                emit(i, ('L', 0, left), word, 'weak_acquire_fail')
                cas_failures += 1
                if word == seen:
                    new_word = word + 1 if role == 'R' else -1
                    emit(i, ('H', 0, left), new_word, 'acquire_success')
            elif pc == 'M':
                if mutation == 'mark_store':
                    emit(i, ('Q', seen | MARK, left), seen | MARK, 'broken_mark_store')
                else:
                    emit(i, ('L', 0, left), word, 'weak_mark_fail')
                    cas_failures += 1
                    if word == seen:
                        emit(i, ('Q', seen | MARK, left), word | MARK, 'mark_success')
            elif pc == 'Q':
                if word != seen:
                    emit(i, ('L', 0, left), word, 'wait_value_mismatch')
                    mismatched_waits += 1
                elif mutation == 'split_wait':
                    emit(i, ('K', seen, left), word, 'broken_wait_compare')
                else: emit(i, ('P', seen, left), word, 'atomic_compare_and_park')
            elif pc == 'K':
                emit(i, ('P', seen, left), word, 'broken_wait_register')
            elif pc == 'H':
                if role == 'R':
                    notify_word = (MARK | 1) if aware else 1
                    nxt = ('N', 0, left) if word == notify_word and mutation != 'omit_reader_notify' else finish(t)
                    emit(i, nxt, word-1, 'read_release')
                else:
                    emit(i, ('N', 0, left), 0, 'writer_release_store')
            elif pc == 'N':
                parked = [j for j,other in enumerate(ts) if other[0] == 'P']
                if role == 'R' or mutation == 'writer_notify_one':
                    # No fairness choice: ANY waiter, reader or writer, may wake.
                    for j in parked: emit(i, finish(t), word, f'notify_one_{j}', (j,))
                    if not parked: emit(i, finish(t), word, 'notify_none')
                else: emit(i, finish(t), word, 'notify_all', parked)
        if not successors: return failed(state, 'all_remaining_parked_deadlock')
        for new, label in successors:
            transitions += 1
            if new not in parents:
                parents[new] = (state, label)
                queue.append(new)
    return {'passed': True, 'states': len(parents), 'transitions': transitions,
            'terminalStates': terminal, 'weakCasFailureTransitions': cas_failures,
            'waitMismatchTransitions': mismatched_waits}


def run():
    start = time.monotonic()
    rows = []
    cases = [('R', (2,)), ('W', (2,)), ('RW', (1,1)), ('RRW', (1,1,1)),
             ('RWW', (1,1,1)), ('RRWW', (1,1,1,1)), ('RW', (2,2)),
             ('RRW', (2,1,1)), ('RWW', (2,1,1)), ('RRRRW', (1,1,1,1,1))]
    for aware in (False, True):
        for roles, ops in cases:
            result = explore(roles, ops, aware)
            if not result['passed'] or not result['terminalStates']: raise RuntimeError((roles,ops,aware,result))
            rows.append({'roles': roles, 'operations': ops, 'waiterAware': aware, **result})
    mutants = {}
    for mutation,roles,ops,aware in [('split_wait','RW',(1,1),True),
                                    ('mark_store','RW',(1,1),True),
                                    ('omit_reader_notify','RW',(1,1),True),
                                    ('writer_notify_one','RWW',(1,1,1),True)]:
        result = explore(roles,ops,aware,mutation)
        if result['passed']: raise RuntimeError(('undetected mutation',mutation))
        mutants[mutation] = {'roles': roles, 'operations': ops, 'waiterAware': aware, **result}
    return {'stage':'4a','passed':True,'model':'finite SC atomic-word protocol with atomic compare-and-park',
            'counterBits':2,'marker':MARK,'cases':rows,'negativeControls':mutants,
            'checkerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'python':platform.python_version(),'elapsedSeconds':time.monotonic()-start}

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists(): raise SystemExit('Refusing to overwrite evidence')
    result=run()
    text=json.dumps(result,indent=2)+'\n'
    with args.output.open('x') as file:file.write(text)
    print(text,end='')
