import assert from 'node:assert/strict';
import {test} from 'node:test';
import {extractTemplates, parseMemoryImports, TESTED, validateTuple} from './restore_cache_diagnostic.mjs';

const leb = n => { const bytes = []; do { const b = n & 127; n = Math.floor(n / 128); bytes.push(b | (n ? 128 : 0)); } while (n); return bytes; };
const name = s => [...leb(Buffer.byteLength(s)), ...Buffer.from(s)];
const section = ({flags = 3, initial = 1028, maximum = 65536, module = 'env', field = 'memory'} = {}) => Uint8Array.from([
  2, ...name('wasi_snapshot_preview1'), ...name('fd_write'), 0, 0,
  ...name(module), ...name(field), 2, flags, ...leb(initial), ...(flags & 1 ? leb(maximum) : []),
]);

test('only the original tested source/producer/template tuple is accepted', () => {
  validateTuple(TESTED);
  for (const key of ['producerRun', 'sourceSha', 'wvlRevision']) assert.throws(() => validateTuple({...TESTED, [key]: 'wrong'}));
});

test('reads imported memory limits without compiling a module', () => {
  assert.deepEqual(parseMemoryImports(section()), {module: 'env', name: 'memory', initial: 1028, maximum: 65536, shared: true});
  assert.throws(() => parseMemoryImports(section({flags: 1})), /true/);
  assert.throws(() => parseMemoryImports(section({flags: 7})), /unsupported/);
  assert.throws(() => parseMemoryImports(section({maximum: 100})), /incompatible/);
  assert.throws(() => parseMemoryImports(section({initial: 40000})), /incompatible/);
  assert.throws(() => parseMemoryImports(section({module: 'other'})));
  assert.throws(() => parseMemoryImports(section().slice(0, -1)), /truncated/);
  assert.throws(() => parseMemoryImports(Uint8Array.from([...section(), 0])), /trailing/);
});

test('reconstructs only required templates and fails closed on drift', () => {
  const source = `
fn common_ts() -> &'static str { r#"common"#.trim() }
fn thread_spawn_ts() -> &'static str { r#"spawn"#.trim() }
fn worker_background_worker_ts() -> &'static str { r#"background"#.trim() }
fn worker_ts(wasm_name: &str) -> String {
 format!(r#"import {{ WASIFarmAnimal }} from 'shim';
const wasm = './{wasm_name}.core.wasm'; const mem = {{ {memories} }};
"#)
}
fn vite_config_ts() -> &'static str { }
`;
  const files = extractTemplates(source, {initial: 1234, maximum: 65536});
  assert.deepEqual(Object.keys(files), ['common.ts', 'thread_spawn.ts', 'worker_background_worker.ts', 'worker.ts']);
  assert.match(files['worker.ts'], /initial:1234/);
  assert.match(files['worker.ts'], /vfs\.core\.wasm/);
  assert.ok(!files['worker.ts'].includes('{{'));
  assert.throws(() => extractTemplates(source.replace('fn common_ts()', 'fn changed()'), {}), /template common_ts/);
  assert.throws(() => extractTemplates(source.replace('{memories}', 'unexpected'), {}));
});
