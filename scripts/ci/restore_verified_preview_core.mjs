// Restore the exact optimized core for frontend-only experiments, never re-optimize.
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createBrotliDecompress} from 'node:zlib';
import {createHash} from 'node:crypto';
const [root,checksumFile,output]=process.argv.slice(2);
if(!output)throw Error('usage: restore_verified_preview_core <preview> <checksums> <new-output>');
const names=(await readdir(join(root,'assets'))).filter(n=>n.endsWith('.wasm.br.json'));
if(names.length!==1)throw Error('expected one core manifest');
const m=JSON.parse(await readFile(join(root,'assets',names[0]),'utf8'));
const sha=/^vfs\.core-([a-f0-9]{64})\.wasm$/.exec(m.originalFile)?.[1];
const expected=(await readFile(checksumFile,'utf8')).split(/\r?\n/).find(l=>/\s+dist\/vfs\.core\.wasm$/.test(l))?.trim().split(/\s+/)[0];
if(!sha||sha!==expected||!Number.isSafeInteger(m.originalSize)||m.originalSize<1||m.originalSize>1024**3||!Array.isArray(m.parts)||!m.parts.length)throw Error('invalid core identity/size');
for(const p of m.parts)if(basename(p.file)!==p.file||['.','..'].includes(p.file))throw Error('unsafe part');
async function* chunks(){for(const p of m.parts){let size=0;for await(const chunk of createReadStream(join(root,'assets',p.file))){size+=chunk.length;yield chunk;}if(size!==p.size)throw Error('part size mismatch');}}
const hash=createHash('sha256');let size=0;
await pipeline(Readable.from(chunks()),createBrotliDecompress(),new Transform({transform(chunk,encoding,cb){size+=chunk.length;if(size>m.originalSize)return cb(Error('excess decoded bytes'));hash.update(chunk);cb(null,chunk);}}),createWriteStream(output,{flags:'wx'}));
if(size!==m.originalSize||hash.digest('hex')!==sha)throw Error('core digest mismatch; retain failed output, do not consume');
console.log(JSON.stringify({passed:true,output,bytes:size,sha256:sha,scope:'byte-identical core restoration; no optimization'}));
