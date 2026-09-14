// Loopback HTTP/TLS and two actual native processes; never seed normal/legacy DB.
import assert from "node:assert/strict";
import { spawn,execFileSync } from "node:child_process";
import { mkdtemp,readFile,mkdir,readdir,copyFile,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
assert.equal(process.platform,"darwin");
assert.ok((await fetch("http://127.0.0.1:1420")).ok,"Start npm run dev first");
const database=await mkdtemp(join(tmpdir(),"postmen-m3-db-"));
const identifier=`com.postmen.nativeqa.m3${Date.now()}`;
const dataStoreIdentifier=randomUUID();
const key=join(database,"localhost.key"),cert=join(database,"localhost.crt");
execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=localhost"],{stdio:"ignore"});
const requests=[];
const timers=new Set();
const server=createServer((req,res)=>{
 req.resume();requests.push({method:req.method,path:req.url});
 const respond=()=>{let body=Buffer.from(JSON.stringify({ok:true,name:"日本語",path:req.url}));res.setHeader("Content-Type","application/json");res.setHeader("x-repeat",["first","second"]);
 if(req.url==="/gzip"){body=gzipSync(body);res.setHeader("Content-Encoding","gzip");}
 if(req.url==="/html"){body=Buffer.from('<script>globalThis.injected=true</script>');res.setHeader("Content-Type","text/html");}
 if(req.url==="/large"){body=Buffer.from("日".repeat(500000));res.setHeader("Content-Type","text/plain; charset=utf-8");}
 if(req.url==="/empty"){res.statusCode=204;body=Buffer.alloc(0);}
 if(req.url==="/error")res.statusCode=500;
 res.end(body);
 };
 if(req.url==="/slow"){const timer=setTimeout(()=>{timers.delete(timer);respond();},10000);timers.add(timer);res.on("close",()=>{clearTimeout(timer);timers.delete(timer);});}else respond();
});
const tls=createTlsServer({key:await readFile(key),cert:await readFile(cert)},(_req,res)=>res.end("must not accept untrusted TLS"));
await Promise.all([new Promise(done=>server.listen(0,"127.0.0.1",done)),new Promise(done=>tls.listen(0,"127.0.0.1",done))]);
const reports=[];
try {
 for(const phase of ["first","restore"]){
  const output=await mkdtemp(join(tmpdir(),`postmen-m3-${phase}-`));
  // Isolated WebKit preference store; keep it across the two QA processes.
  const config={identifier,app:{windows:[{label:"main",title:"PostMen Native Regression",width:1440,height:840,minWidth:700,minHeight:400,center:!reports.length,create:false,incognito:false,titleBarStyle:"Overlay",hiddenTitle:true,trafficLightPosition:{x:12,y:20},dragDropEnabled:false}]}};
  const child=spawn(resolve("node_modules/.bin/tauri"),["dev","--config","src-tauri/tauri.smoke.conf.json","--config",JSON.stringify(config),"--features","native-smoke","--no-watch"],{cwd:resolve("."),stdio:"inherit",env:{...process.env,POSTMEN_SMOKE_DATA_STORE_ID:dataStoreIdentifier,POSTMEN_SMOKE_MILESTONE:"M3",POSTMEN_SMOKE_DIR:output,POSTMEN_SMOKE_DATABASE_DIR:database,POSTMEN_SMOKE_RESTORE:phase==="restore"?"1":"0",POSTMEN_SMOKE_HTTP:`http://127.0.0.1:${server.address().port}`,POSTMEN_SMOKE_TLS:`https://127.0.0.1:${tls.address().port}`,POSTMEN_SMOKE_EXPECTED_WINDOW:join(database,"expected-window.json")}});
  const watchdog=setTimeout(()=>child.kill("SIGTERM"),360000);
  let code;try{code=await new Promise((done,reject)=>{child.on("error",reject);child.on("close",done);});}finally{clearTimeout(watchdog);}
  assert.equal(code,0,`Native ${phase} process failed`);
  const report=JSON.parse(await readFile(join(output,"native-smoke.json"),"utf8"));assert.equal(report.nativeDesktop,true);assert.equal(report.milestone,"M3");assert.equal(report.restoreProcess,phase==="restore");reports.push({phase,output,checks:report.checks});
 }
 // A discarded URL from process two must not replace Save All from process one.
 const saved=execFileSync("sqlite3",[join(database,"postmen.sqlite3"),"SELECT url FROM requests;"],{encoding:"utf8"}).trim();assert.equal(saved,"/saved-on-quit");
 if(process.argv.includes("--m4-report")||process.argv.includes("--m4-os-report")){
  const destination=resolve(process.argv.includes("--m4-os-report")?"docs/milestones/M4/os-input-fixed/native-regression":"docs/milestones/M4/native-regression");await mkdir(destination,{recursive:true});
  for(const report of reports){const target=join(destination,report.phase);await mkdir(target,{recursive:true});await copyFile(join(report.output,"native-smoke.json"),join(target,"native-smoke.json"));
   for(const name of await readdir(report.output))if(name.endsWith(".tiff"))execFileSync("sips",["-s","format","png",join(report.output,name),"--out",join(target,name.replace(/\.tiff$/,".png"))],{stdio:"ignore"});
  }
  await writeFile(join(destination,"runner.json"),JSON.stringify({checkedAt:new Date().toISOString(),milestone:"M4",kind:"M3 workflow regression on M4 implementation",passed:true,identifier,dataStoreIdentifier,database,reports,requests},null,2)+"\n");
 }
 console.log(JSON.stringify({passed:true,identifier,dataStoreIdentifier,database,reports,requests,note:"Temporary QA artifacts and explicit isolated WebKit store retained. No normal/legacy DB seeded."},null,2));
}finally{for(const timer of timers)clearTimeout(timer);server.closeAllConnections();tls.closeAllConnections();await Promise.all([new Promise(done=>server.close(done)),new Promise(done=>tls.close(done))]);}
