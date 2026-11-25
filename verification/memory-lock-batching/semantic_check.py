#!/usr/bin/env python3
"""Stage 2a: exhaustive reduced-domain validation, not a Wasm bitvector proof."""
import argparse
import hashlib
import itertools
import json
import platform
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CELL_BITS = 2
WORD_BITS = 4
CELL_MASK = 3
WORD_MASK = 15
WVL_REVISION = '77f45543eb976e4e7843e78fcd67bd837acac6bd'
SOURCE_PATHS = [
    'wasi_virt_layer-cli/src/wasm_stream/passes/memory_lock_batching.rs',
    'wasi_virt_layer-cli/src/wasm_stream/passes/multi_memory_lowering.rs',
    'wasi_virt_layer/src/memory_lock.rs',
]
# get/set/tee are locals; initial locals 0=address, 1=value, 2=zero.
# Each initial operand stack also has a live arbitrary word below all operands.
PROGRAMS = {
    'narrow_signed_mixed_guests': (
        ('get', 0), ('get', 1), ('store', 0, 1),
        ('get', 0), ('load', 0, 1, True), ('set', 2), ('barrier',),
        ('get', 0), ('get', 2), ('store', 1, 1),
        ('get', 0), ('load', 1, 1, False), ('get', 2), ('add',)),
    'wide_little_endian_live_stack': (
        ('const', 0), ('get', 1), ('store', 1, 2),
        ('const', 0), ('load', 1, 2, False), ('tee', 2), ('barrier',),
        ('const', 0), ('get', 2), ('store', 0, 2),
        ('const', 0), ('load', 0, 2, False), ('xor',)),
    'bridge_arithmetic_truncation': (
        ('get', 0), ('load', 0, 1, True), ('get', 1), ('add',), ('set', 2),
        ('get', 0), ('get', 2), ('store', 1, 1),
        ('get', 0), ('load', 1, 1, False), ('barrier',),
        ('get', 0), ('load', 0, 1, False)),
}


def reference(program, initial, value, address):
    """Logical-memory source interpreter: no bases, locks, or physical storage."""
    memory = [list(initial[:2]), list(initial[2:])]
    stack, locals_ = [15 - value], [address, value, 0]
    for op in program:
        kind = op[0]
        if kind == 'get':
            stack.append(locals_[op[1]])
        elif kind == 'const':
            stack.append(op[1])
        elif kind == 'set':
            locals_[op[1]] = stack.pop()
        elif kind == 'tee':
            locals_[op[1]] = stack[-1]
        elif kind == 'add':
            right, left = stack.pop(), stack.pop()
            stack.append((left + right) % 16)
        elif kind == 'xor':
            right, left = stack.pop(), stack.pop()
            stack.append(left ^ right)
        elif kind == 'store':
            v, a = stack.pop(), stack.pop()
            guest, width = op[1:]
            if not 0 <= a <= 2 - width:
                raise AssertionError('reference out of bounds')
            for j in range(width):
                memory[guest][a + j] = (v // (4 ** j)) % 4
        elif kind == 'load':
            a = stack.pop()
            guest, width, signed = op[1:]
            if not 0 <= a <= 2 - width:
                raise AssertionError('reference out of bounds')
            v = sum(memory[guest][a + j] * (4 ** j) for j in range(width))
            if signed and v >= (4 ** width) // 2:
                v -= 4 ** width
            stack.append(v % 16)
        elif kind != 'barrier':
            raise AssertionError(kind)
    return tuple(stack), tuple(locals_), tuple(memory[0] + memory[1])


def lowered(program, initial, value, address, bound, request_at, mutation='none'):
    """Independent physical-memory interpreter for hand-modeled emitted plumbing.

    A relocation request occurs at one original-op boundary. It is serviced at
    the first unlocked point. No guest/data mutation is performed by the writer.
    """
    physical = {i: v for i, v in enumerate(initial)}
    bases = [0, 2]
    cache = [None, None]
    stack = [value ^ WORD_MASK]
    locals_ = [address, value, 0]
    held, count, requested, moved = False, 0, False, False
    acquisitions = 0

    def relocate_if_possible():
        nonlocal moved
        if requested and not held and not moved:
            # Snapshot BEFORE invalidation; this is a trusted content-preserving move.
            snapshot = [physical[bases[g] + j] for g in range(2) for j in range(2)]
            for old in range(4):
                physical[old] = -1  # retired storage must never be accessed
            bases[:] = [8, 10]
            for j, cell in enumerate(snapshot):
                physical[8 + j] = cell
            moved = True

    for pc, op in enumerate(program + (('barrier',),)):
        if pc == request_at:
            requested = True
        relocate_if_possible()
        kind = op[0]
        if held and (count >= bound or kind == 'barrier'):
            held, count = False, 0
            relocate_if_possible()
        if kind in ('load', 'store'):
            # Operand spill precedes acquisition. Temp variables model fresh locals.
            saved_value = stack.pop() if kind == 'store' else None
            saved_addr = stack.pop()
            if mutation == 'reverse_store_operands' and kind == 'store':
                saved_value, saved_addr = saved_addr, saved_value
            if not held:
                held, count = True, 0
                acquisitions += 1
            guest, width = op[1:3]
            if mutation == 'stale_base' and cache[guest] is not None:
                base = cache[guest]
            else:
                base = bases[guest]
                cache[guest] = base
            if not 0 <= saved_addr <= 2 - width:
                raise AssertionError('lowered out of bounds')
            effective = (base + saved_addr) & WORD_MASK
            if any(physical.get(effective + j, -1) < 0 for j in range(width)):
                raise AssertionError('retired or invalid physical cell')
            if kind == 'store':
                for j in range(width):
                    physical[effective + j] = (saved_value >> (CELL_BITS * j)) & CELL_MASK
            else:
                bits = 0
                for j in range(width):
                    bits |= physical[effective + j] << (CELL_BITS * j)
                if op[3] and bits & (1 << (CELL_BITS * width - 1)):
                    bits |= WORD_MASK ^ ((1 << (CELL_BITS * width)) - 1)
                stack.append(bits)
        elif kind == 'get':
            stack.append(locals_[op[1]])
        elif kind == 'const':
            stack.append(op[1])
        elif kind == 'set':
            locals_[op[1]] = stack.pop()
        elif kind == 'tee':
            temporary = stack.pop()
            locals_[op[1]] = temporary
            stack.append(temporary)
        elif kind in ('add', 'xor'):
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(((lhs + rhs) if kind == 'add' else (lhs ^ rhs)) & WORD_MASK)
        elif kind != 'barrier':
            raise AssertionError(kind)
        if held:
            count += 1
            if count > bound:
                raise AssertionError('region bound exceeded')
    if held or not moved:
        raise AssertionError('normal exit or relocation missing')
    final_memory = tuple(physical[bases[g] + j] for g in range(2) for j in range(2))
    return (tuple(stack), tuple(locals_), final_memory), acquisitions


def baseline(program, initial, value, address, request_at, mutation='none'):
    # Insert explicit releases as barriers after each access, preserving request
    # positions in the ORIGINAL program. No guest-visible effects at these barriers.
    expanded = []
    translated_request = None
    for pc, op in enumerate(program):
        if pc == request_at:
            translated_request = len(expanded)
        expanded.append(op)
        if op[0] in ('load', 'store'):
            expanded.append(('barrier',))
    if request_at == len(program):
        translated_request = len(expanded)
    return lowered(tuple(expanded), initial, value, address, 64, translated_request, mutation)


def provenance():
    checkout = ROOT / '.worktrees/wvl-lock-batching'
    revision = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'],
                              check=True, capture_output=True, text=True).stdout.strip()
    if revision != WVL_REVISION:
        raise AssertionError(('unexpected target revision', revision))
    return {'targetRevision': revision, 'sourceSha256': {
        path: hashlib.sha256((checkout / path).read_bytes()).hexdigest() for path in SOURCE_PATHS}}


def run():
    if not __debug__:
        raise RuntimeError('run without Python -O')
    started = time.monotonic()
    checks = references = elisions = 0
    coverage = {}
    for name, program in PROGRAMS.items():
        local_checks = 0
        for initial in itertools.product(range(4), repeat=4):
            for value in range(16):
                for address in range(2):
                    expected = reference(program, initial, value, address)
                    references += 1
                    for request in range(len(program) + 1):
                        actual, baseline_acquires = baseline(program, initial, value, address, request)
                        if actual != expected:
                            raise AssertionError(('baseline mismatch', name, initial, value, address, request))
                        checks += 1
                        local_checks += 1
                        for bound in (1, 3, 64):
                            actual, acquires = lowered(program, initial, value, address, bound, request)
                            if actual != expected:
                                raise AssertionError(('candidate mismatch', name, initial, value, address, request, bound))
                            if acquires < baseline_acquires:
                                elisions += 1
                            checks += 1
                            local_checks += 1
        coverage[name] = {'originalOperators': len(program), 'comparisons': local_checks}
    controls = {}
    for mutation in ('stale_base', 'reverse_store_operands'):
        found = None
        for name, program in PROGRAMS.items():
            if found:
                break
            for value, address, request in itertools.product(range(16), range(2), range(len(program) + 1)):
                initial = (0, 1, 2, 3)
                expected = reference(program, initial, value, address)
                try:
                    actual, _ = lowered(program, initial, value, address, 3, request, mutation)
                    reason = 'semantic mismatch' if actual != expected else None
                except AssertionError as error:
                    reason = str(error)
                if reason:
                    found = {'program': name, 'initialCells': initial, 'value': value,
                             'address': address, 'relocationRequestAt': request,
                             'bound': 3, 'detected': True, 'reason': reason}
                    break
        if not found:
            raise AssertionError(('undetected mutation', mutation))
        controls[mutation] = found
    return {'schemaVersion': 1, 'stage': '2a', 'passed': True,
            'claim': 'exhaustive reduced-domain validation for selected templates, not full Wasm proof',
            'domain': {'cellBits': CELL_BITS, 'wordBits': WORD_BITS, 'guests': 2,
                       'cellsPerGuest': 2, 'initialMemoryStates': 256, 'storeWords': 16,
                       'addresses': [0, 1], 'batchBounds': [1, 3, 64], 'relocations': 1},
            'referenceInputs': references, 'comparisons': checks,
            'candidateRunsWithAcquisitionElision': elisions, 'coverage': coverage,
            'negativeControls': controls, **provenance(),
            'checkerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'environment': {'python': sys.version, 'platform': platform.platform()},
            'elapsedSeconds': time.monotonic() - started}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = run()
    text = json.dumps(result, indent=2) + '\n'
    if args.output:
        with args.output.open('x') as output:
            output.write(text)
    print(text, end='')
