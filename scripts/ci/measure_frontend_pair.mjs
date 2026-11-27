import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import puppeteer from 'puppeteer';
import {startBrowserStaticServer,closeBrowserStaticServer} from '../lsp_browser_static_server.mjs';
import {measureEditorInteractions} from '../startup_interaction_measurement.mjs';
const [pairArg,outArg]=process.argv.slice(2);if(!outArg)throw Error('usage: measure_frontend_pair pair-root fresh-results');
const root=resolve(pairArg),out=resolve(outArg);await mkdir(out);
const result={status:'fail',scope:'frontend flag A-B-B-A; not deployed baseline Cargo acceptance',sessions:[],startedAt:new Date().toISOString()};
try{
 for(const [i,mode] of ['off','on','on','off'].entries()){
  const session={i,mode,visits:[],errors:[]};result.sessions.push(session);let server,browser;
  try{
   server=await startBrowserStaticServer({rootDirectory:join(root,mode),port:0});const url=`http://127.0.0.1:${server.address().port}/`;
   browser=await puppeteer.launch({headless:true,protocolTimeout:330000,args:['--no-sandbox','--disable-setuid-sandbox']});session.browser=await browser.version();
   const page=await browser.newPage();await page.setViewport({width:1280,height:900});await page.evaluateOnNewDocument(()=>Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>4}));
   page.on('pageerror',e=>session.errors.push(String(e)));page.on('console',m=>{if(m.text().startsWith('[stdlib-cache]')){session.cacheReports??=[];session.cacheReports.push(m.text());}});
   for(const visit of ['cold','reload']){
    const start=performance.now();await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>['ready','failed'].includes(window.__rubrcLspTest?.startup?.phase),{timeout:300000,polling:250});
    const readyMs=performance.now()-start;const state=await page.evaluate(()=>window.__rubrcLspTest.startup);if(state.phase!=='ready')throw Error(JSON.stringify(state));
    const interaction=await measureEditorInteractions(page,join(out,`${i}-${mode}-${visit}`));
    const endToEndMs=performance.now()-start;
    session.visits.push({visit,readyMs,endToEndMs,under30s:endToEndMs<=30000,state,interaction});console.log(JSON.stringify({i,mode,visit,readyMs,endToEndMs}));
    await writeFile(join(out,'progress.json'),JSON.stringify(result,null,2));
   }
  }finally{if(browser)await browser.close();await closeBrowserStaticServer(server);}
 }
 if(result.sessions.some(s=>s.errors.length))throw Error('page errors observed');result.status='complete';result.allVisitsUnder30s=result.sessions.every(s=>s.visits.every(v=>v.under30s));
}catch(error){result.error=String(error);process.exitCode=1;}
finally{result.finishedAt=new Date().toISOString();await writeFile(join(out,'result.json'),JSON.stringify(result,null,2)+'\n');}
