import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile, lstat, mkdir, open, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateCacheProof, verifyCacheEntry} from './optimizer_checkpoint.mjs';

export const TESTED = Object.freeze({
  producerRun: '45032121283',
  sourceSha: '0673d0a0b2a2fa0499fc661ec5ce1f6029c035d6',
  wvlRevision: '456a69aa9223e2e1b90cf260c573f31782987238',
  coreSha256: '375a07601afac782b81ffd7d49a0891bf7980cca395e5deabd918e569ea06502',
});

export function validateTuple(tuple) {
  for (const key of ['producerRun', 'sourceSha', 'wvlRevision']) {
    assert.equal(tuple[key], TESTED[key], `unsupported diagnostic ${key}`);
  }
}

// Parse only the bounded import section; never load/compile the large code section.
export function parseMemoryImports(bytes) {
  let offset = 0;
  const byte = () => { assert.ok(offset < bytes.length, 'truncated import section'); return bytes[offset++]; };
  const u32 = () => {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const b = byte();
      if (i === 4) assert.ok(b <= 15, 'invalid u32 LEB');
      n += (b & 127) * 2 ** (7 * i);
      if (!(b & 128)) return n;
    }
    assert.fail('invalid u32 LEB');
  };
  const name = () => {
    const n = u32(); assert.ok(offset + n <= bytes.length, 'truncated import name');
    const s = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(offset, offset + n));
    offset += n; return s;
  };
  const limits = () => {
    const flags = u32(); assert.ok(flags <= 3, 'unsupported memory64/table limits');
    const initial = u32(); const maximum = flags & 1 ? u32() : undefined;
    return {initial, maximum, shared: !!(flags & 2)};
  };
  const memories = [];
  const count = u32();
  for (let i = 0; i < count; i++) {
    const module = name(), field = name(), kind = byte();
    switch (kind) {
      case 0: u32(); break;
      case 1: assert.ok([0x70, 0x6f].includes(byte()), 'unsupported table ref type'); limits(); break;
      case 2: memories.push({module, name: field, ...limits()}); break;
      case 3: assert.ok([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f].includes(byte()), 'unsupported global type'); assert.ok(byte() <= 1); break;
      case 4: assert.equal(byte(), 0, 'unsupported tag attribute'); u32(); break;
      default: assert.fail(`unsupported import kind ${kind}`);
    }
  }
  assert.equal(offset, bytes.length, 'trailing import bytes');
  assert.equal(memories.length, 1, 'diagnostic requires exactly one imported memory');
  const memory = memories[0];
  assert.equal(memory.module, 'env'); assert.equal(memory.name, 'memory');
  assert.equal(memory.shared, true); assert.ok(memory.initial > 0);
  assert.ok(memory.maximum >= 32775 && memory.initial <= 32775, 'original driver maximum incompatible');
  return memory;
}

export async function inspectMemory(path) {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    let offset = 0;
    const take = async n => {
      assert.ok(offset + n <= size, 'truncated wasm');
      const b = Buffer.alloc(n); const {bytesRead} = await file.read(b, 0, n, offset);
      assert.equal(bytesRead, n, 'short wasm read'); offset += n; return b;
    };
    assert.deepEqual(await take(8), Buffer.from([0,97,115,109,1,0,0,0]), 'expected core wasm');
    while (offset < size) {
      const id = (await take(1))[0]; let length = 0, done = false;
      for (let i = 0; i < 5; i++) {
        const b = (await take(1))[0]; if (i === 4) assert.ok(b <= 15);
        length += (b & 127) * 2 ** (7 * i);
        if (!(b & 128)) { done = true; break; }
      }
      assert.ok(done && offset + length <= size, 'invalid section length');
      if (id === 2) { assert.ok(length <= 16 * 1024 * 1024, 'oversized import section'); return parseMemoryImports(await take(length)); }
      assert.ok(id <= 2, 'missing import section'); offset += length;
    }
    assert.fail('missing import section');
  } finally { await file.close(); }
}

export function extractTemplates(source, memory) {
  const files = {};
  for (const [file, fn] of [['common.ts','common_ts'], ['thread_spawn.ts','thread_spawn_ts'], ['worker_background_worker.ts','worker_background_worker_ts']]) {
    const pattern = new RegExp(`fn ${fn}\\(\\) -> &'static str \\{\\s*r#\"([\\s\\S]*?)\"#\\s*\\.trim\\(\\)\\s*\\}`, 'g');
    const matches = [...source.matchAll(pattern)]; assert.equal(matches.length, 1, `unexpected template ${fn}`);
    files[file] = matches[0][1].trim();
  }
  const worker = source.slice(source.indexOf('fn worker_ts('), source.indexOf('fn vite_config_ts('));
  const matches = [...worker.matchAll(/r#"\s*(import \{\{ WASIFarmAnimal \}\}[\s\S]*?)"#/g)];
  assert.equal(matches.length, 1, 'unexpected worker template');
  assert.ok(matches[0][1].includes('{wasm_name}.core.wasm') && matches[0][1].includes('{memories}'));
  files['worker.ts'] = matches[0][1].trim().replaceAll('{wasm_name}', 'vfs')
    .replace('{memories}', `memory: new WebAssembly.Memory({ initial:${memory.initial}, maximum:${memory.maximum}, shared:true }),`)
    .replaceAll('{{', '{').replaceAll('}}', '}');
  return files;
}

async function hash(path) {
  const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex');
}

export async function restore({cacheDir, evidenceDir, wvlDir, outputDir, producerRun, sourceSha, wvlRevision}) {
  validateTuple({producerRun, sourceSha, wvlRevision});
  const rows = (await readFile(join(evidenceDir, 'optimization-invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const finals = rows.filter(row => row.tool === 'wasm-opt' && row.stage === 'final-core');
  assert.equal(finals.length, 1, 'one final-core invocation required');
  const row = finals[0]; assert.equal(row.status, 0); assert.equal(row.signal, null);
  const proof = validateCacheProof(row.cacheProof, {args: row.args, stage: 'final-core', sourceSha, mode: 'batching-off', profile: 'strong-compatible-v1', binaryenCores: '1'});
  assert.equal(proof.producer.runId, producerRun); assert.equal(proof.producer.phase, 'finish');
  assert.equal(proof.outputSha256, TESTED.coreSha256);
  assert.ok(proof.identity.args.includes('-O3'), 'expected final O3');
  const sums = (await readFile(join(evidenceDir, 'artifact-sha256.txt'), 'utf8')).split('\n');
  const coreSums = sums.filter(line => /^[a-f0-9]{64}  dist\/vfs\.core\.wasm$/.test(line));
  assert.deepEqual(coreSums, [`${proof.outputSha256}  dist/vfs.core.wasm`]);
  await verifyCacheEntry(cacheDir, proof);
  const core = join(cacheDir, proof.key, 'output.wasm');
  const memory = await inspectMemory(core);
  const js = await readFile(join(evidenceDir, 'generated-vfs-bindings.txt'), 'utf8');
  const modules = [...new Set(js.match(/vfs\.core(?:\d+)?\.wasm/g) ?? [])];
  assert.deepEqual(modules, ['vfs.core.wasm'], 'unexpected generated core module set');
  assert.ok(js.includes('instantiate'), 'missing binding instantiator');
  const source = await readFile(join(wvlDir, 'wasi_virt_layer-cli/src/test_run/thread.rs'), 'utf8');
  const files = extractTemplates(source, memory);
  // Fresh staging only. The caller uses the original copy script in a disposable checkout.
  try { await lstat(outputDir); assert.fail('restore output already exists'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(outputDir, {recursive: true});
  await copyFile(core, join(outputDir, 'vfs.core.wasm'));
  assert.equal(await hash(join(outputDir, 'vfs.core.wasm')), proof.outputSha256);
  await writeFile(join(outputDir, 'vfs.js'), js, {flag: 'wx'});
  for (const [name, text] of Object.entries(files)) await writeFile(join(outputDir, name), text + '\n', {flag: 'wx'});
  const report = {diagnosticOnly: true, producerRun, sourceSha, wvlRevision, proof, memory, bindingSha256: createHash('sha256').update(js).digest('hex')};
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 3, 'usage: restore_cache_diagnostic.mjs <config.json>');
  await restore(JSON.parse(await readFile(process.argv[2], 'utf8')));
}
