import {spawnSync} from 'node:child_process';
import {readFile,readdir,cp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {finalizeVfsAsset,digest} from '../finalize_vfs_asset.mjs';
const [previewArg,coreArg,outArg]=process.argv.slice(2);if(!outArg)throw Error('usage: prepare_frontend_pair preview core new-output');
const preview=resolve(previewArg),core=resolve(coreArg),out=resolve(outArg);await mkdir(out);
const {inspectMemory}=await import('./restore_cache_diagnostic.mjs');
const memory=await inspectMemory(core);
const limitsPath='page/src/worker_process/vfs_bindings/memory_limits.ts';
await readFile(limitsPath,'utf8'); // Inspect existing generated input before replacing in disposable build checkout.
await writeFile(limitsPath,`// Restored from verified Wasm import section.\nexport const VFS_INITIAL_MEMORY_PAGES = ${memory.initial};\n`);
const workerPath='page/src/worker_process/vfs_bindings/worker.ts';
const worker=await readFile(workerPath,'utf8');
if([...worker.matchAll(/initial:\s*\d+/g)].length!==1)throw Error('ambiguous worker memory size');
await writeFile(workerPath,worker.replace(/initial:\s*\d+/,`initial:${memory.initial}`));
const identity=[];
for(const mode of ['off','on']){
 const dist=join(out,mode);
 const child=spawnSync('bun',['x','vite','build','--outDir',dist],{cwd:'page',env:{...process.env,NODE_ENV:'production',VITE_RUBRC_LSP_TEST:'1',VITE_RUBRC_RA_SINGLE_PROJECT_INIT:mode==='on'?'1':'0'},stdio:'inherit'});
 if(child.status!==0)throw Error('frontend build failed '+mode);
 const verified=await finalizeVfsAsset({source:core,dist});
 await cp(join(preview,'v1'),join(dist,'v1'),{recursive:true});
 for(const name of await readdir(preview))if(name==='rust-src.sqfs'||name==='std-cache.json'||/^std-.*\.salsa\.part-\d+$/.test(name))await cp(join(preview,name),join(dist,name));
 for(const name of await readdir(join(preview,'assets')))if(name.includes('.wasm.br'))await cp(join(preview,'assets',name),join(dist,'assets',name));
 const cache=JSON.parse(await readFile(join(dist,'std-cache.json'),'utf8'));
 const cacheParts=[];for(const part of cache.parts){if(!/^std-[a-f0-9]+\.salsa\.part-\d+$/.test(part.file))throw Error('invalid cache part');const actual=await digest(join(dist,part.file));if(actual!==await digest(join(preview,part.file)))throw Error('copied cache mismatch');cacheParts.push({file:part.file,sha256:actual});}
 identity.push({mode,memory,adapterSha:await digest('page/src/worker_process/vfs_bindings/vfs.js'),coreSha:verified.sha256,rustSrcSha:await digest(join(dist,'rust-src.sqfs')),cacheManifestSha:await digest(join(dist,'std-cache.json')),cacheParts});
}
if(JSON.stringify({...identity[0],mode:''})!==JSON.stringify({...identity[1],mode:''}))throw Error('identity mismatch');
await writeFile(join(out,'identity.json'),JSON.stringify({source:process.env.SOURCE_SHA,identity,flag:'VITE_RUBRC_RA_SINGLE_PROJECT_INIT',scope:'same source/dependencies/core/cache; frontend-only flag pair'},null,2));
