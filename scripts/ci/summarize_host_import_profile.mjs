import {readFile,writeFile} from 'node:fs/promises';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('usage: summarize_host_import_profile <result.json> <new-summary.json>');
const result=JSON.parse(await readFile(input,'utf8'));const rows=new Map();let workers=0;
for(const snapshot of result.snapshots){if(snapshot.profile)workers++;for(const instance of snapshot.profile?.instances??[])for(const row of instance.functions){
 const key=JSON.stringify([row.module,row.name]);let total=rows.get(key);if(!total){total={module:row.module,name:row.name,calls:0,throws:0,timedCalls:0,sampledInclusiveMs:0,maxSampleMs:0,clockErrors:0};rows.set(key,total);}
 for(const k of ['calls','throws','timedCalls','sampledInclusiveMs','clockErrors'])total[k]+=row[k];total.maxSampleMs=Math.max(total.maxSampleMs,row.maxSampleMs);
}}
const sorted=[...rows.values()].sort((a,b)=>b.calls-a.calls);
const report={status:result.status,browser:result.browser,elapsedMs:result.elapsedMs,realmsWithProfiler:workers,realmsObserved:result.snapshots.length,functions:sorted,limitations:['Live realms at final snapshot only; terminated workers may be absent.','Counts include startup and snapshot interval, not phase isolation.','Periodic samples may be biased; durations are synchronous inclusive, may include waits/nesting.','No extrapolated sum is claimed to equal page startup wall time.','Instrumented timings are not acceptance benchmark.']};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(sorted.slice(0,20),null,2));
