import test from 'node:test';
import assert from 'node:assert/strict';
import {profileHostImports} from './host_import_profile.mjs';
const descriptors = [{module:'env',name:'clock',kind:'function'},{module:'env',name:'memory',kind:'memory'}];
test('preserves return, receiver, BigInt arguments, memory and input namespace', () => {
  const memory = new WebAssembly.Memory({initial:1});
  function clock(a) { assert.equal(this.token,42);return a+1n; }
  const input={env:{clock,memory}};let t=0;
  const p=profileHostImports(input,descriptors,{now:()=>++t,sampleEvery:2});
  assert.equal(p.imports.env.clock.call({token:42},8n),9n);
  assert.equal(p.imports.env.clock.call({token:42},9n),10n);
  assert.equal(p.imports.env.memory,memory);assert.equal(input.env.clock,clock);
  const row=p.snapshot().functions[0];assert.equal(row.calls,2);assert.equal(row.timedCalls,1);assert.equal(row.sampledInclusiveMs,1);
  row.calls=99;assert.equal(p.snapshot().functions[0].calls,2);
});
test('preserves thrown identity and does not time every call',()=>{
 const error=new Error('guest-visible');let clocks=0;
 const p=profileHostImports({env:{clock(){throw error;}}},descriptors,{sampleEvery:2,now:()=>++clocks});
 for(let i=0;i<3;i++)assert.throws(()=>p.imports.env.clock(),x=>x===error);
 assert.equal(clocks,2);assert.equal(p.snapshot().functions[0].throws,3);
});
test('profiling clock failures cannot change host result or exception',()=>{
 const p=profileHostImports({env:{clock:()=>7}},descriptors,{sampleEvery:1,now:()=>{throw Error('clock');}});
 assert.equal(p.imports.env.clock(),7);assert.equal(p.snapshot().functions[0].clockErrors,1);
});
test('duplicate import descriptors share one counter and async returns are not awaited',()=>{
 const promise=Promise.resolve(4);const p=profileHostImports({env:{clock:()=>promise}},[...descriptors,descriptors[0]]);
 assert.equal(p.imports.env.clock(),promise);assert.equal(p.snapshot().functions.length,1);
});
test('rejects invalid sample interval and missing function',()=>{
 assert.throws(()=>profileHostImports({},[],{sampleEvery:0}));
 assert.throws(()=>profileHostImports({},descriptors));
});
