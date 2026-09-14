// OS QA driver; DOM/SQLite are assertion oracles, never input substitutes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rename, appendFile, open, unlink } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { destination } from "./m4-os-paths.mjs";
export { destination };

export const session=JSON.parse(await readFile(join(destination,"session.json"),"utf8"));
// Native probe IPC has one slot. Refuse concurrent drivers before any OS input.
const lockFile=join(session.output,"driver.lock");
async function lock(){
  try {
    const file=await open(lockFile,"wx");
    await file.writeFile(JSON.stringify({pid:process.pid,appPid:session.pid}));
    await file.close();
  }catch(error){
    if(error.code!=="EEXIST")throw error;
    const owner=JSON.parse(await readFile(lockFile,"utf8"));
    assert.ok(Number.isInteger(owner.pid)&&owner.pid>0&&owner.appPid===session.pid,"Invalid QA driver lock");
    let alive=true;
    try{process.kill(owner.pid,0);}catch(e){if(e.code==="ESRCH")alive=false;else throw e;}
    assert.equal(alive,false,`Another QA driver is active (PID ${owner.pid}); wait for completion`);
    await unlink(lockFile);
    return lock();
  }
}
await lock();
process.once("exit",()=>{
  try{if(JSON.parse(readFileSync(lockFile,"utf8")).pid===process.pid)unlinkSync(lockFile);}catch{}
});
const read=async file=>JSON.parse(await readFile(file,"utf8"));
async function log(event){await appendFile(join(destination,"actions.jsonl"),JSON.stringify({at:new Date().toISOString(),pid:session.pid,...event})+"\n")}
export async function probe(op,args={}){
  const id=Date.now();
  await writeFile(join(session.output,"os-command.tmp"),JSON.stringify({id,op,...args}));
  await rename(join(session.output,"os-command.tmp"),join(session.output,"os-command.json"));
  const started=Date.now();
  while(Date.now()-started<15000){
    try {const response=await read(join(session.output,"os-response.json"));if(response.id===id){assert.equal(response.ok,true,response.error);return response.value;}}catch(error){if(error.code!=="ENOENT")throw error;}
    await delay(80);
  }
  throw Error(`QA probe timed out: ${op}`);
}
export async function os(action,input={}){
  const result=JSON.parse(execFileSync("rtk",["proxy","/tmp/postmen-m4-os-input",String(session.pid),action,JSON.stringify(input)],{encoding:"utf8",timeout:20000,maxBuffer:6e6}));
  if(action!=="inspect")await log({kind:"OS-input",action,input,result});
  return result;
}
export async function wait(expression,timeout=12000){
  const started=Date.now();let value;
  while(Date.now()-started<timeout){value=await probe("probe",{expression});if(value===true)return;await delay(150);}
  throw Error(`QA assertion timed out: ${expression}; last=${JSON.stringify(value)}`);
}
export async function clickUI(selector,text=null){
  const state=await probe("probe",{expression:`(()=>{const list=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=list.find(e=>${text===null?"true":`e.textContent.trim()===${JSON.stringify(text)}`});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,viewport:{width:innerWidth,height:innerHeight}};})()`});
  assert.ok(state&&state.width>0&&state.height>0,`No visible UI: ${selector}, ${text}`);
  assert.ok(state.x>=0&&state.y>=0&&state.x<state.viewport.width&&state.y<state.viewport.height,"UI is outside viewport; scroll using OS first");
  const info=await os("windows");
  const window=info.windows.find(w=>w.kCGWindowLayer===0&&w.kCGWindowIsOnscreen&&w.kCGWindowAlpha===1&&w.kCGWindowBounds.Width>=700&&w.kCGWindowBounds.Height>=400);
  assert.ok(window,"No visible QA window");
  await log({kind:"UI-target",selector,text,point:state});
  await os("click",{x:window.kCGWindowBounds.X+state.x,y:window.kCGWindowBounds.Y+state.y});
  await delay(200);
}
export async function typeUI(selector,text){
  await clickUI(selector);
  await os("key",{code:0,modifiers:["cmd"]});
  await os("type",{text});
  await delay(200);
}
export async function screen(name){
  assert.match(name,/^[a-z0-9-]+$/);
  const info=await os("windows");
  const window=info.windows.find(w=>w.kCGWindowLayer===0&&w.kCGWindowIsOnscreen&&w.kCGWindowAlpha===1&&w.kCGWindowBounds.Width>=700&&w.kCGWindowBounds.Height>=400);
  assert.ok(window,"No visible QA window");
  const file=join(destination,`${name}.png`);
  execFileSync("rtk",["proxy","screencapture","-x","-o","-l",String(window.kCGWindowNumber),file],{timeout:10000});
  await log({kind:"OS-window-screenshot",file,window});
  return file;
}
export async function check(name,detail,passed=true){await log({kind:"assertion",passed,name,detail});console.log(`${passed?"PASS":"FAIL"} ${name}`)}

if(process.argv[1]&&resolve(process.argv[1])===resolve("scripts/m4-os-driver.mjs")){
  const action=process.argv[2],args=JSON.parse(process.argv[3]??"{}");
  let value;
  if(action==="probe")value=await probe(args.op??"probe",args);
  else if(action==="screen")value=await screen(args.name);
  else if(action==="click-ui")value=await clickUI(args.selector,args.text??null);
  else if(action==="type-ui")value=await typeUI(args.selector,args.text);
  else value=await os(action,args);
  console.log(JSON.stringify(value??{ok:true},null,2));
}
