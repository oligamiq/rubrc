import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {brotliCompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const script=resolve('scripts/ci/restore_verified_preview_core.mjs');
async function fixture(){
 await mkdir('target/restore-core-tests',{recursive:true});const root=await mkdtemp('target/restore-core-tests/case-');await mkdir(join(root,'assets'));
 const bytes=Buffer.from('small verified Wasm fixture'),sha=createHash('sha256').update(bytes).digest('hex'),compressed=brotliCompressSync(bytes);
 const manifest={originalFile:`vfs.core-${sha}.wasm`,originalSize:bytes.length,parts:[{file:'part-000',size:compressed.length}]};
 await writeFile(join(root,'assets','part-000'),compressed);await writeFile(join(root,'assets','vfs.wasm.br.json'),JSON.stringify(manifest));await writeFile(join(root,'checksums'),`${sha}  dist/vfs.core.wasm\n`);
 return {root,bytes,manifest};
}
function run(root){return spawnSync(process.execPath,[script,root,join(root,'checksums'),join(root,'output.wasm')],{encoding:'utf8'});}
test('restores byte-identical checked core and refuses overwrite',async()=>{const {root,bytes}=await fixture();const r=run(root);assert.equal(r.status,0,r.stderr);assert.deepEqual(await readFile(join(root,'output.wasm')),bytes);assert.notEqual(run(root).status,0);});
test('rejects source hash mismatch before output',async()=>{const {root}=await fixture();await writeFile(join(root,'checksums'),'0'.repeat(64)+'  dist/vfs.core.wasm\n');assert.notEqual(run(root).status,0);});
test('rejects decoded-size overflow',async()=>{const {root,manifest}=await fixture();manifest.originalSize=1;await writeFile(join(root,'assets','vfs.wasm.br.json'),JSON.stringify(manifest));assert.notEqual(run(root).status,0);});
test('rejects traversal in part name',async()=>{const {root,manifest}=await fixture();manifest.parts[0].file='../other';await writeFile(join(root,'assets','vfs.wasm.br.json'),JSON.stringify(manifest));assert.notEqual(run(root).status,0);});
