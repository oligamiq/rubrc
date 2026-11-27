import {readFile} from 'node:fs/promises';
import {WASI} from 'node:wasi';
import assert from 'node:assert/strict';
const wasi=new WASI({version:'preview1',args:[],env:{},returnOnExit:true});let instance,length=0,position=0,count=0;
const probe={reset(n){length=n;position=0;count=0;},calls(){return count;},copied(){return position;},chunk(ptr,len){assert.ok(len>0&&len<=512*1024);assert.ok(position+len<=length);const view=new Uint8Array(instance.exports.memory.buffer,ptr,len);for(let i=0;i<len;i++)view[i]=(position+i)%251;position+=len;count++;return 0;}};
instance=(await WebAssembly.instantiate(await readFile(process.argv[2]),{wasi_snapshot_preview1:wasi.wasiImport,probe})).instance;
assert.equal(wasi.start(instance),0);
