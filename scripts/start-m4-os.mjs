// Long-running isolated native fixture. A separate driver performs OS input.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { destination } from "./m4-os-paths.mjs";

assert.equal(process.platform,"darwin");
assert.ok((await fetch("http://127.0.0.1:1420")).ok,"Start Vite first");
await mkdir(destination,{recursive:true});
const previous=process.argv.includes("--restore") ? JSON.parse(await readFile(join(destination,"session.json"),"utf8")) : null;
if(!previous){
  let existing=false;
  try{await access(join(destination,"first-start.json"));existing=true;}catch(error){if(error.code!=="ENOENT")throw error;}
  assert.equal(existing,false,"Archive the existing os-input evidence before starting a fresh QA run");
}
const database=previous?.database ?? await mkdtemp(join(tmpdir(),"postmen-m4-os-db-"));
const output=await mkdtemp(join(tmpdir(),"postmen-m4-os-run-"));
const identifier=previous?.identifier ?? `com.postmen.nativeqa.os${Date.now()}`;
const dataStoreIdentifier=previous?.dataStoreIdentifier ?? randomUUID();
// Restoration shares the loopback endpoint; retain first-process HTTP evidence.
const requests=previous ? JSON.parse(await readFile(join(destination,"requests.json"),"utf8")) : [];
const server=createServer((request,response)=>{
  const chunks=[];
  request.on("data",chunk=>chunks.push(chunk));
  request.on("end",async()=>{
    const body=Buffer.concat(chunks).toString("utf8");
    requests.push({method:request.method,path:request.url,body,contentType:request.headers["content-type"]});
    await writeFile(join(destination,"requests.json"),JSON.stringify(requests,null,2)+"\n");
    response.writeHead(200,{"Content-Type":"application/json"});
    response.end(JSON.stringify({success:true,message:"PostMen OS QA",upload:request.url?.startsWith("/upload")}));
  });
});
await new Promise((done,reject)=>{server.once("error",reject);server.listen(previous?.port ?? 0,"127.0.0.1",done)});
const port=server.address().port;
const config={identifier,app:{windows:[{label:"main",title:"PostMen OS QA",width:1100,height:720,minWidth:700,minHeight:400,center:true,create:false,incognito:false,titleBarStyle:"Overlay",hiddenTitle:true,trafficLightPosition:{x:12,y:20},dragDropEnabled:false}]}};
const child=spawn(resolve("node_modules/.bin/tauri"),["dev","--config","src-tauri/tauri.smoke.conf.json","--config",JSON.stringify(config),"--features","native-smoke","--no-watch"],{stdio:"inherit",env:{...process.env,POSTMEN_SMOKE_MILESTONE:"M4_OS",POSTMEN_SMOKE_DIR:output,POSTMEN_SMOKE_DATABASE_DIR:database,POSTMEN_SMOKE_DATA_STORE_ID:dataStoreIdentifier,POSTMEN_SMOKE_ENDPOINT:`http://127.0.0.1:${port}`}});
let ended=false;
const closed=new Promise((done,reject)=>{child.on("error",reject);child.on("close",code=>{ended=true;done(code)})});
try {
  const started=Date.now();
  while(!ended){
    try {await access(join(output,"os-ready.json"));break;}catch{}
    if(Date.now()-started>180000)throw Error("OS QA startup timeout");
    await delay(300);
  }
  assert.equal(ended,false,"QA app exited before ready");
  const ready=JSON.parse(await readFile(join(output,"os-ready.json"),"utf8"));
  const session={pid:ready.pid,database,output,identifier,dataStoreIdentifier,port,startedAt:new Date().toISOString(),restore:!!previous,ready};
  await writeFile(join(destination,"session.json"),JSON.stringify(session,null,2)+"\n");
  await writeFile(join(destination,previous?"restore-start.json":"first-start.json"),JSON.stringify(session,null,2)+"\n");
  console.log(JSON.stringify({ready:true,pid:ready.pid,output,database,restore:!!previous}));
  const code=await closed;
  await writeFile(join(destination,previous?"restore-exit.json":"first-exit.json"),JSON.stringify({code,endedAt:new Date().toISOString()},null,2)+"\n");
  assert.equal(code,0,"Native process failed");
} finally {
  if(!ended)child.kill("SIGTERM");
  server.closeAllConnections();
  await new Promise(done=>server.close(done));
}
