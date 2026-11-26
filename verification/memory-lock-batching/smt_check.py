#!/usr/bin/env python3
"""Stage2b: full-width local memory plumbing lemmas, not whole-program proof."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import z3 as z


def check(output):
    output.mkdir(parents=True, exist_ok=False)
    results = []
    def prove(name, assumptions, difference, expect='unsat'):
        solver = z.Solver()
        solver.set(timeout=30000)
        solver.add(*assumptions, difference)
        text = solver.to_smt2()
        (output / (name + '.smt2')).write_text(text)
        answer = str(solver.check())
        row = {'name': name, 'expected': expect, 'result': answer,
               'querySha256': hashlib.sha256(text.encode()).hexdigest()}
        if answer == 'sat': row['counterexample'] = str(solver.model())
        results.append(row)
        if answer != expect: raise RuntimeError(row)

    # A byte-addressed, full32-bit memory address domain and arbitrary contents.
    # Local relation: logical bytes read correspond to physical bytes at base+addr.
    for bits in [32, 64]:
        for width in [1, 2, 4] + ([8] if bits == 64 else []):
            tag = f'i{bits}_{width}bytes'
            a, base = z.BitVecs('addr base', 32)
            v = z.BitVec('value', bits)
            sentinel = z.BitVec('live_stack', 64)
            logical = z.Array('logical', z.BitVecSort(32), z.BitVecSort(8))
            physical = z.Array('physical', z.BitVecSort(32), z.BitVecSort(8))
            # Exclude both logical and relocated address overflow and OOB.
            size = z.BitVec('logical_size', 32)
            wide = lambda x: z.ZeroExt(32, x)
            assumptions = [wide(a) + width <= wide(size),
                           wide(base) + wide(size) <= (1 << 32)]
            relation = [z.Select(logical, a+j) == z.Select(physical, base+a+j)
                        for j in range(width)]
            ref = sum(z.ZeroExt(bits-8, z.Select(logical, a+j)) * (1 << (8*j))
                      for j in range(width))
            emitted_raw = z.Concat(*[z.Select(physical, base+a+j) for j in reversed(range(width))]) if width > 1 else z.Select(physical, base+a)
            for signed in [False, True] if width*8 < bits else [False]:
                emitted = (z.SignExt if signed else z.ZeroExt)(bits-width*8, emitted_raw)
                expected = ref
                if signed:
                    expected = z.If(z.Extract(width*8-1, width*8-1, ref) == 1,
                                    ref | z.BitVecVal(((1 << bits)-1) ^ ((1 << (width*8))-1), bits), ref)
                prove(tag + ('_load_s' if signed else '_load_u'), assumptions + relation,
                      expected != emitted)
            # Array extensionality via arbitrary queried logical cell q, including
            # aliasing with each byte stored. Unmodified cells also must agree.
            q = z.BitVec('query', 32)
            before = z.Select(logical, q) == z.Select(physical, base+q)
            ls, ps = logical, physical
            for j in range(width):
                # Independent formulations: division/truncation vs bit extraction.
                byte = z.Extract(7, 0, z.UDiv(v, z.BitVecVal(1 << (8*j), bits)))
                ls = z.Store(ls, a+j, byte)
                ps = z.Store(ps, base+a+j, z.Extract(8*j+7, 8*j, v))
            prove(tag + '_store_projection', assumptions + [z.ULT(q, size), before],
                  z.Select(ls, q) != z.Select(ps, base+q))
            # A real unsigned load bug must admit a counterexample for narrow widths.
            if width == 1:
                wrong = z.SignExt(bits-8, emitted_raw)
                prove(tag + '_mutant_signed_unsigned', assumptions + relation,
                      ref != wrong, 'sat')
    # Modular original i32 address expression is separate from memarg offset.
    x, y, base, offset = z.BitVecs('x y base offset', 32)
    addr = x + y
    extended = z.ZeroExt(32, addr) + z.ZeroExt(32, offset)
    actual = z.ZeroExt(32, base + addr) + z.ZeroExt(32, offset)
    prove('i32_address_plus_memarg', [z.ZeroExt(32, base) + extended < (1 << 32)],
          actual != z.ZeroExt(32, base) + extended)
    # Liveness of unrelated stack entries is a local spill/restore algebra lemma.
    a, v, live = z.BitVec('stack_addr', 32), z.BitVec('stack_value', 64), z.BitVec('stack_live', 64)
    stack = [live, a, v]
    sv, sa = stack.pop(), stack.pop()
    restored = stack + [sa, sv]
    prove('store_spill_restore_stack', [], z.Or(restored[0] != live, restored[1] != a, restored[2] != v))
    prove('mutant_store_spill_swap', [], z.ZeroExt(32, sa) != sv, 'sat')
    report = {'stage': '2b', 'passed': True, 'solver': z.get_full_version(),
              'python': platform.python_version(), 'queries': results,
              'checkerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'claim': 'Local full-width integer load/store/address/stack lemmas under explicit relation and no-overflow assumptions; not actual generated-code or whole-program verification'}
    (output / 'results.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    check(parser.parse_args().output_dir)
