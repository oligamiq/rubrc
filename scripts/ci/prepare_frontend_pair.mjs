import {spawnSync} from 'node:child_process';
import {readFile,readdir,cp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {finalizeVfsAsset,digest} from '../finalize_vfs_asset.mjs';
const [previewArg,coreArg,outArg]=process.argv.slice(2);if(!outArg)throw Error('usage: prepare_frontend_pair preview core new-output');
const preview=resolve(previewArg),core=resolve(coreArg),out=resolve(outArg);await mkdir(out);
const identity=[];
for(const mode of ['off','on']){
 const dist=join(out,mode);
 const child=spawnSync('bun',['x','vite','build','--outDir',dist],{cwd:'page',env:{...process.env,NODE_ENV:'production',VITE_RUBRC_LSP_TEST:'1',VITE_RUBRC_RA_SINGLE_PROJECT_INIT:mode==='on'?'1':'0'},stdio:'inherit'});
 if(child.status!==0)throw Error('frontend build failed '+mode);
 const verified=await finalizeVfsAsset({source:core,dist});
 for(const name of await readdir(preview))if(name==='rust-src.sqfs'||name==='std-cache.json'||/^std-.*\.salsa\.part-\d+$/.test(name))await cp(join(preview,name),join(dist,name));
 for(const name of await readdir(join(preview,'assets')))if(name.includes('.wasm.br'))await cp(join(preview,'assets',name),join(dist,'assets',name));
 identity.push({mode,coreSha:verified.sha256,rustSrcSha:await digest(join(dist,'rust-src.sqfs')),cacheManifestSha:await digest(join(dist,'std-cache.json'))});
}
if(JSON.stringify({...identity[0],mode:''})!==JSON.stringify({...identity[1],mode:''}))throw Error('identity mismatch');
await writeFile(join(out,'identity.json'),JSON.stringify({source:process.env.SOURCE_SHA,identity,flag:'VITE_RUBRC_RA_SINGLE_PROJECT_INIT',scope:'same source/dependencies/core/cache; frontend-only flag pair'},null,2));
