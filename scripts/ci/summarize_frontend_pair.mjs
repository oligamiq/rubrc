import {readFile,writeFile} from 'node:fs/promises';
const [input,output]=process.argv.slice(2);if(!output)throw Error('usage: summarize_frontend_pair result.json summary.json');
const r=JSON.parse(await readFile(input,'utf8'));
const rows=r.sessions.flatMap(s=>s.visits.map(v=>({session:s.i,mode:s.mode,visit:v.visit,readyMs:v.readyMs,endToEndMs:v.endToEndMs,under30s:v.endToEndMs<=30000,completionMs:v.interaction.completionMs,diagnosticMs:v.interaction.diagnosticMs})));
const summaries=[];for(const mode of ['off','on'])for(const visit of ['cold','reload']){const a=rows.filter(r=>r.mode===mode&&r.visit===visit).map(r=>r.endToEndMs);if(a.length)summaries.push({mode,visit,count:a.length,minMs:Math.min(...a),maxMs:Math.max(...a),meanMs:a.reduce((a,b)=>a+b,0)/a.length});}
const result={runStatus:r.status,rows,summaries,complete:r.status==='complete'&&rows.length===8,releaseAccepted:false,limits:['Local hosted static server, no network shaping; not deployed public baseline.','All editor interactions verified sequentially; end-to-end includes probe screenshot and cleanup overhead.','Two independent sessions per arm, cold and reload are not independent replicates.','Cargo non-regression and exact successful exit code not established by editor timings.']};
await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
