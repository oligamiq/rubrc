import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installHostImportProfile,hostImportBootstrapSource} from './host_import_profile_bootstrap.mjs';
import {profileHostImports} from './host_import_profile.mjs';
// module imports env.f(i32)->i32 and re-exports it. Exercises actual Wasm host boundary.
const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,127,2,9,1,3,101,110,118,1,102,0,0,7,5,1,1,102,0,0]);
function realm(){return {WebAssembly:{Instance:WebAssembly.Instance,instantiate:WebAssembly.instantiate,instantiateStreaming:WebAssembly.instantiateStreaming},performance,location:{href:'test:worker'}};}
test('captures constructor, module instantiate and bytes instantiate without duplicate counts',async()=>{
 const r=realm();const p=installHostImportProfile(r,profileHostImports,{sampleEvery:1});
 const m=await WebAssembly.compile(bytes);const imp={env:{f:n=>n+1}};
 const a=new r.WebAssembly.Instance(m,imp);assert.ok(a instanceof WebAssembly.Instance);assert.equal(a.exports.f(1),2);
 const b=await r.WebAssembly.instantiate(m,imp);assert.equal(b.exports.f(3),4);
 const c=await r.WebAssembly.instantiate(bytes,imp);assert.equal(c.instance.exports.f(5),6);
 assert.deepEqual(p.snapshot().instances.map(x=>x.functions[0].calls),[1,1,1]);
 assert.throws(()=>installHostImportProfile(r,profileHostImports));p.restore();assert.equal(r.WebAssembly.Instance,WebAssembly.Instance);
});
test('captures streaming instantiate and preserves exceptions',async()=>{
 const r=realm();const p=installHostImportProfile(r,profileHostImports);
 const error=Error('host');const {instance}=await r.WebAssembly.instantiateStreaming(new Response(bytes,{headers:{'Content-Type':'application/wasm'}}),{env:{f(){throw error;}}});
 assert.throws(()=>instance.exports.f(1),e=>e===error);assert.equal(p.snapshot().instances[0].functions[0].throws,1);
});
test('serialized bootstrap works in separate realm without module imports',async()=>{
 const r=realm();vm.runInNewContext(hostImportBootstrapSource({sampleEvery:2}),r);
 const {instance}=await r.WebAssembly.instantiate(bytes,{env:{f:n=>n}});assert.equal(instance.exports.f(9),9);
 assert.equal(r.__rubrcHostImports.snapshot().instances[0].functions[0].calls,1);
});
