#!/usr/bin/env python3
"""Finite explicit-state safety model; stdlib only. See SPEC.md for scope."""
from collections import deque
from itertools import product
import argparse
import hashlib
import json
from pathlib import Path


def lower(program, bound, mutation='none'):
    events = []
    active = False
    count = 0
    fetched = False
    for op in program + 'X':  # explicit normal region/function exit
        limit_reached = count > bound if mutation == 'late_bound' else count >= bound
        if active and (limit_reached or op == 'X'):
            if not (mutation == 'hold_boundary' and op == 'X'):
                events.append('release')
                active, count = False, 0
        if op == 'A':
            if not active:
                if mutation != 'omit_acquire':
                    events.append('acquire')
                active, count = True, 0
            if mutation != 'stale_base' or not fetched:
                events.append('base')
                fetched = True
            if mutation == 'early_release':
                events.append('release')
            events.append('access')
        elif op == 'B':
            events.append('bridge')
        else:
            events.append('barrier')
        if active:
            count += 1
    return tuple(events)


def explore(programs, bound, mutation='none'):
    streams = tuple(lower(p, bound, mutation) for p in programs)
    n = len(streams)
    # (reader PCs, lock ownership, cached base epochs, region opcode counts,
    #  relocation epoch, writer phase [idle,exclusive,done])
    initial = ((0,) * n, (False,) * n, (-1,) * n, (0,) * n, 0, 0)
    queue = deque([initial])
    parents = {initial: None}
    edges = 0
    terminal = 0

    def trace(state, action):
        result = [action]
        while parents[state] is not None:
            previous, label = parents[state]
            result.append(label)
            state = previous
        return list(reversed(result))

    def add(state, new, label):
        nonlocal edges
        edges += 1
        if new not in parents:
            parents[new] = (state, label)
            queue.append(new)

    while queue:
        state = queue.popleft()
        pcs, held, bases, counts, epoch, writer = state
        failure = None
        if writer == 1 and any(held):
            failure = 'writer_reader_exclusion'
        if any(c > bound for c in counts):
            failure = 'region_bound'
        if failure:
            return {'passed': False, 'invariant': failure, 'trace': trace(state, 'violation'), 'states': len(parents)}
        if any(pc == len(events) and owner for pc, events, owner in zip(pcs, streams, held)):
            return {'passed': False, 'invariant': 'normal_exit_release', 'trace': trace(state, 'exit'), 'states': len(parents)}
        if all(pc == len(events) for pc, events in zip(pcs, streams)) and writer == 2:
            terminal += 1
        if writer == 0 and (not any(held) or mutation == 'writer_ignores_readers'):
            add(state, (pcs, held, bases, counts, epoch, 1), 'writer.acquire')
        if writer == 1:
            add(state, (pcs, held, bases, counts, epoch + 1, 2), 'writer.relocate_and_release')
        for i, events in enumerate(streams):
            if pcs[i] == len(events):
                continue
            action = events[pcs[i]]
            label = f'reader{i}.{action}'
            if action == 'acquire' and writer == 1:
                continue
            p, h, b, c = map(list, (pcs, held, bases, counts))
            failure = None
            if action == 'acquire':
                if h[i]: failure = 'double_acquire'
                h[i], c[i] = True, 0
            elif action == 'release':
                if not h[i]: failure = 'unmatched_release'
                h[i], c[i] = False, 0
            elif action == 'base':
                if not h[i]: failure = 'base_without_lock'
                b[i] = epoch
            elif action == 'access':
                if not h[i]: failure = 'access_without_lock'
                elif b[i] != epoch: failure = 'stale_base'
                c[i] += 1
            elif action == 'bridge':
                if h[i]: c[i] += 1
            elif action == 'barrier' and h[i]:
                failure = 'held_across_boundary'
            if failure:
                return {'passed': False, 'invariant': failure, 'trace': trace(state, label), 'states': len(parents)}
            p[i] += 1
            add(state, (tuple(p), tuple(h), tuple(b), tuple(c), epoch, writer), label)
    return {'passed': True, 'states': len(parents), 'edges': edges, 'terminalStates': terminal}


def run():
    totals = {'cases': 0, 'states': 0, 'edges': 0}
    def check(programs, bound):
        result = explore(programs, bound)
        assert result['passed'], (programs, bound, result)
        assert result['terminalStates'] > 0
        totals['cases'] += 1
        for key in ['states', 'edges']: totals[key] += result[key]
    # All abstract class sequences through length four, one reader + one writer.
    for bound in [1, 2, 3, 64]:
        for size in range(5):
            for ops in product('ABX', repeat=size):
                check((''.join(ops),), bound)
    # Exhaustive pairs through length two with two readers + one writer.
    programs = [''.join(p) for size in range(3) for p in product('ABX', repeat=size)]
    for bound in [1, 2, 64]:
        for pair in product(programs, repeat=2):
            check(pair, bound)
    # Real 64-op edge cases; writer may interleave between every micro-event.
    for program in ['A'*63, 'A'*64, 'A'*65, 'A'*129, 'A'+'B'*63+'A', 'A'+'B'*64+'XA']:
        check((program,), 64)
    controls = {}
    for mutation, program in [('omit_acquire', 'A'), ('hold_boundary', 'AX'),
                              ('writer_ignores_readers', 'A'), ('stale_base', 'AXA'),
                              ('late_bound', 'A' + 'B'*63 + 'A'), ('early_release', 'A')]:
        result = explore((program,), 64, mutation)
        assert not result['passed'], f'undetected mutation: {mutation}'
        controls[mutation] = result
    return {'schemaVersion': 1, 'model': 'finite atomic-RW-lock abstraction',
            'passed': True, 'coverage': totals, 'negativeControls': controls,
            'limitations': ['No fairness/liveness proof', 'No proof of CAS/wait implementation',
                            'No Wasm traps, memory contents, or operand stack in this stage',
                            'Finite chosen programs/readers/one relocation only; not an unbounded theorem'],
            'checkerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}

if __name__ == '__main__':
    if not __debug__:
        raise SystemExit('Do not disable verification assertions with Python -O')
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = run()
    text = json.dumps(result, indent=2) + '\n'
    if args.output:
        with args.output.open('x') as file: file.write(text)
    print(text, end='')
