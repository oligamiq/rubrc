import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import puppeteer from 'puppeteer';
import {startBrowserStaticServer,closeBrowserStaticServer} from '../lsp_browser_static_server.mjs';
import {measureEditorInteractions} from '../startup_interaction_measurement.mjs';
import {measureCargoInteractions} from './measure_cargo_interactions.mjs';
const [pairArg,outArg]=process.argv.slice(2);if(!outArg)throw Error('usage: measure_frontend_pair pair-root fresh-results');
const root=resolve(pairArg),out=resolve(outArg);await mkdir(out);
const result={status:'fail',scope:'frontend flag A-B-B-A; not deployed baseline Cargo acceptance',sessions:[],startedAt:new Date().toISOString()};
try{
 for(const [i,mode] of ['off','on','on','off'].entries()){
  const session={i,mode,visits:[],errors:[],console:[]};result.sessions.push(session);let server,browser,page;
  try{
   server=await startBrowserStaticServer({rootDirectory:join(root,mode),port:0});const url=`http://127.0.0.1:${server.address().port}/`;
   browser=await puppeteer.launch({headless:true,protocolTimeout:330000,args:['--no-sandbox','--disable-setuid-sandbox']});session.browser=await browser.version();
   page=await browser.newPage();await page.setViewport({width:1280,height:900});await page.evaluateOnNewDocument(()=>Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>4}));
   page.on('pageerror',e=>session.errors.push(String(e)));page.on('console',m=>{session.console.push({type:m.type(),text:m.text()});if(session.console.length>2000)session.console.shift();});
   page.on('requestfailed',r=>session.errors.push('requestfailed '+r.url()+' '+r.failure()?.errorText));
   for(const visit of ['cold','reload']){
    const start=performance.now();await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>['ready','failed'].includes(window.__rubrcLspTest?.startup?.phase),{timeout:300000,polling:250});
    const readyMs=performance.now()-start;const state=await page.evaluate(()=>window.__rubrcLspTest.startup);if(state.phase!=='ready')throw Error(JSON.stringify(state));
    const interaction=await measureEditorInteractions(page,join(out,`${i}-${mode}-${visit}`));
    const endToEndMs=performance.now()-start;
    session.visits.push({visit,readyMs,endToEndMs,under30s:endToEndMs<=30000,state,interaction});console.log(JSON.stringify({i,mode,visit,readyMs,endToEndMs}));
    await writeFile(join(out,'progress.json'),JSON.stringify(result,null,2));
   }
   if(process.env.RUBRC_MEASURE_CARGO==='1'){
    const chooser=await page.evaluateHandle(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Select target...'));
    try{if(!chooser.asElement())throw Error('target chooser missing');await chooser.asElement().click();}finally{await chooser.dispose();}
    await page.waitForSelector('input[placeholder="Search target..."]',{timeout:10000});
    await page.type('input[placeholder="Search target..."]','wasm32-wasip1');
    const target=await page.evaluateHandle(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='wasm32-wasip1'));
    try{if(!target.asElement())throw Error('target option missing');await target.asElement().click();}finally{await target.dispose();}
    await page.waitForFunction(()=>window.__rubrcLspTest?.runtime?.selectedTarget==='wasm32-wasip1'&&window.__rubrcLspTest.runtime.operation==='idle',{timeout:180000});
    session.cargo=await measureCargoInteractions(page,{outputDirectory:join(out,`${i}-${mode}-cargo`),metadata:{mode,session:i,baseline:'experimental frontend-off; NOT deployed version'}});
    await writeFile(join(out,'progress.json'),JSON.stringify(result,null,2));
    if(session.cargo.status!=='pass-observed-interactions')throw Error(session.cargo.error??'Cargo interactions failed');
   }
  }catch(error){
   session.error=String(error);
   if(page)try{session.failureState=await page.evaluate(()=>({startup:window.__rubrcLspTest?.startup,body:document.body.innerText.slice(-8000)}));await page.screenshot({path:join(out,`${i}-${mode}-failure.png`)});}catch(e){session.snapshotError=String(e);}
   throw error;
  }finally{if(browser)await browser.close();await closeBrowserStaticServer(server);}
 }
 if(result.sessions.some(s=>s.errors.length))throw Error('page errors observed');result.status='complete';result.allVisitsUnder30s=result.sessions.every(s=>s.visits.every(v=>v.under30s));
}catch(error){result.error=String(error);process.exitCode=1;}
finally{result.finishedAt=new Date().toISOString();await writeFile(join(out,'result.json'),JSON.stringify(result,null,2)+'\n');}
