// Diagnostic preview only: unchanged Wasm, instrumented JS in a fresh private copy.
import {cp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer';
import {hostImportBootstrapSource} from './host_import_profile_bootstrap.mjs';
import {startBrowserStaticServer,closeBrowserStaticServer} from '../lsp_browser_static_server.mjs';
const [sourceArg,outArg]=process.argv.slice(2);
if(!sourceArg||!outArg) throw Error('usage: node profile_preview_host_imports.mjs <preview> <fresh-output>');
const source=resolve(sourceArg),out=resolve(outArg);await mkdir(out);const root=join(out,'instrumented-preview');await cp(source,root,{recursive:true});
const changed=[];
async function instrument(dir){for(const e of await readdir(dir,{withFileTypes:true})){
 const p=join(dir,e.name);if(e.isDirectory())await instrument(p);else if(e.name.endsWith('.js')){
  const original=await readFile(p,'utf8');const bootstrap=hostImportBootstrapSource({sampleEvery:1024});
  const text=`if (!globalThis.__rubrcHostImports) { ${bootstrap} }\n`+original;
  await writeFile(p,text);changed.push({path:p.slice(root.length+1),before:createHash('sha256').update(original).digest('hex'),after:createHash('sha256').update(text).digest('hex')});
 }
}}
const enabled=process.env.RUBRC_HOST_PROFILE!=='0';
if(enabled)await instrument(root);await writeFile(join(out,'instrumentation.json'),JSON.stringify({source,enabled,changed},null,2));
const report={status:'fail',scope:'instrumented diagnostic; not acceptance timing',startedAt:new Date().toISOString(),source,errors:[],console:[],snapshots:[]};
let server,browser;
const deadline=setTimeout(()=>{console.error('global diagnostic timeout');browser?.process()?.kill('SIGKILL');process.exitCode=1;},240000);
try{
 server=await startBrowserStaticServer({rootDirectory:root,port:0});const url=`http://127.0.0.1:${server.address().port}/`;
 report.url=url;console.log(JSON.stringify({kind:'diagnostic-server',url}));
 browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||puppeteer.executablePath(),headless:true,protocolTimeout:210000,args:['--no-sandbox','--disable-setuid-sandbox']});report.browser=await browser.version();
 browser.process()?.on('exit',(code,signal)=>{report.browserExit={code,signal};});
 const page=await browser.newPage();page.on('error',e=>report.errors.push('page-crash '+String(e)));page.on('close',()=>{report.pageClosed=true;});
 report.actualHardwareConcurrency=await page.evaluate(()=>navigator.hardwareConcurrency);
 await page.evaluateOnNewDocument(()=>Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>4}));report.reportedHardwareConcurrency=4;
 page.on('console',m=>{if(report.console.length<2000)report.console.push({type:m.type(),text:m.text()});});page.on('pageerror',e=>report.errors.push(String(e)));
 page.on('requestfailed',r=>report.errors.push('requestfailed '+r.url()+' '+r.failure()?.errorText));
 await page.setViewport({width:1280,height:900});const start=performance.now();
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
 report.isolation=await page.evaluate(()=>crossOriginIsolated);
 try { await page.waitForFunction(()=>['ready','failed'].includes(window.__rubrcLspTest?.startup?.phase),{timeout:180000,polling:250}); }
 catch(error){
  report.waitError={message:String(error),stack:error.stack,cause:String(error.cause),causeStack:error.cause?.stack};
  try{report.failureState=await page.evaluate(()=>({url:location.href,phase:window.__rubrcLspTest?.startup,body:document.body.innerText.slice(0,3000)}));}catch(e){report.failureStateError=String(e);}
  // Blocking workers cannot service ordinary evaluate; preserve failure promptly.
  throw error;
 }
 report.elapsedMs=performance.now()-start;
 report.startup=await page.evaluate(()=>({startup:window.__rubrcLspTest?.startup,measurements:window.__rubrcLspTest?.measurements}));
 for(const target of (enabled ? browser.targets().filter(t=>t.url().startsWith(url)) : [])){
  const session=await target.createCDPSession();let paused=false;
  try{
   await session.send('Debugger.enable');
   const event=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('pause timeout')),5000);session.once('Debugger.paused',e=>{clearTimeout(timer);resolve(e);});});
   await session.send('Debugger.pause');const pause=await event;paused=true;
   const value=await session.send('Debugger.evaluateOnCallFrame',{callFrameId:pause.callFrames[0].callFrameId,expression:'JSON.stringify(globalThis.__rubrcHostImports?.snapshot()??null)',returnByValue:true});
   report.snapshots.push({url:target.url(),profile:JSON.parse(value.result.value)});
  }catch(error){report.errors.push('snapshot '+target.url()+': '+String(error));}
  finally{if(paused)await session.send('Debugger.resume').catch(()=>{});await session.detach();}
 }
 const calls=report.snapshots.flatMap(x=>x.profile?.instances??[]).flatMap(x=>x.functions).reduce((sum,x)=>sum+x.calls,0);
 if(report.startup.startup.phase!=='ready'||(enabled&&!calls))throw Error('startup or import coverage failed');report.calls=calls;report.status='diagnostic-complete';
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
 if(browser){try{await browser.close();}catch{browser.process()?.kill('SIGKILL');}}
 await closeBrowserStaticServer(server);clearTimeout(deadline);report.finishedAt=new Date().toISOString();await writeFile(join(out,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,url:report.url,calls:report.calls,error:report.error,result:join(out,'result.json')}));
}
