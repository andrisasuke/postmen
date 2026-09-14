// Run once before OS Quit, then --restore after start-m4-os.mjs --restore.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { session, destination, probe, os, typeUI, clickUI, wait, screen, check } from "./m4-os-driver.mjs";

const finishOnly=process.argv.includes("--finish-only");
const restore=process.argv.includes("--restore")||finishOnly;
const requestId=session.ready.workspace.requests.find(r=>r.name==="OS request").id;
const settings=()=>probe("probe",{expression:"JSON.parse(localStorage.getItem('postmen.shell.settings.v1'))"});
// The long-running fixture can replace its HTTP log between polling reads.
// Retry only a partial JSON snapshot; real I/O errors still fail the test.
async function readRequests(){
  for(let attempt=0;attempt<20;attempt++){
    try{return JSON.parse(await readFile(join(destination,"requests.json"),"utf8"));}
    catch(error){if(!(error instanceof SyntaxError)||attempt===19)throw error;await delay(25);}
  }
}
async function waitForExit(){
  for(let i=0;i<100;i++){
    try{process.kill(session.pid,0);}catch(error){if(error.code==="ESRCH")return;throw error;}
    await delay(100);
  }
  throw Error("QA native PID remains alive after OS Quit");
}
if(!restore){
  await os("size",{width:1100,height:720});
  await os("position",{x:120,y:80});
  await wait("innerWidth===1100 && innerHeight===720");
  await clickUI('[aria-label="Change theme"]');
  await clickUI('[role=menuitemradio][aria-label="Light"]');
  await wait("document.documentElement.dataset.theme==='light'");
  if((await settings()).orientation!=="horizontal")await os("menu",{path:["View","Toggle Response Layout"]});
  await clickUI(`[data-request-tab="${requestId}"]`);
  const url=`http://127.0.0.1:${session.port}/json?os-save-all-before-restart=${Date.now()}`;
  await typeUI('[aria-label="Request URL"]',url);
  await wait("!!document.querySelector('.dirty-dot')");
  const normal=await probe("state");
  await os("menu",{path:["Window","Zoom"]});
  await delay(600);
  const zoomed=await probe("state");
  assert.equal(zoomed.maximized,true);
  const expected={pid:session.pid,database:session.database,dataStoreIdentifier:session.dataStoreIdentifier,url,normal,zoomed,settings:await settings(),workspace:await probe("workspace")};
  await writeFile(join(destination,"restart-expected.json"),JSON.stringify(expected,null,2)+"\n");
  await os("key",{code:12,modifiers:["cmd"]});
  await wait("document.querySelector('[role=dialog]')?.textContent.includes('Save changes')===true");
  await screen("os-save-all-before-restart");
  await clickUI('[role=dialog] button',"Save All and Quit");
  await waitForExit();
  await check("os-cmd-q-save-all-actual-process-exit",{pid:session.pid,url});
}else{
  const expected=JSON.parse(await readFile(join(destination,"restart-expected.json"),"utf8"));
  if(!finishOnly){
  assert.notEqual(session.pid,expected.pid);
  assert.equal(session.database,expected.database);
  assert.equal(session.dataStoreIdentifier,expected.dataStoreIdentifier);
  const state=await probe("state"),workspace=await probe("workspace"),request=await probe("request",{requestId});
  assert.equal(request.url,expected.url);
  assert.deepEqual(workspace.session.tabIds,expected.workspace.session.tabIds);
  assert.equal(workspace.session.activeId,expected.workspace.session.activeId);
  assert.deepEqual(await settings(),expected.settings);
  await check("os-restart-saved-request-tabs-theme-layout",{previousPid:expected.pid,pid:session.pid});
  const restoredMaximized=state.maximized===true&&state.fullscreen===false;
  await check("os-restart-maximized-same-monitor",{expected:expected.zoomed,state},restoredMaximized);
  await screen("os-restored-light-maximized");
  if(state.maximized)await os("menu",{path:["Window","Zoom"]});
  await delay(600);
  const normal=await probe("state");
  const normalRestored=JSON.stringify(normal.position)===JSON.stringify(expected.normal.position)&&JSON.stringify(normal.size)===JSON.stringify(expected.normal.size);
  await check("os-restart-unzoom-restores-normal-size-position",{expected:expected.normal,actual:normal},normalRestored);
  await writeFile(join(destination,"restart-actual.json"),JSON.stringify({state,normal,workspace,request,settings:await settings()},null,2)+"\n");
  await screen("os-restored-light-windowed");
  }
  const count=(await readRequests()).length;
  await os("menu",{path:["View","Send Request"]});
  // A previous response may still be visible; await this HTTP invocation itself.
  let requests=[];
  for(let i=0;i<100;i++){
    requests=await readRequests();
    if(requests.length>count)break;
    await delay(100);
  }
  assert.equal(requests.length,count+1);
  assert.equal(requests.at(-1).path,new URL(expected.url).pathname+new URL(expected.url).search);
  await wait("document.querySelector('[data-testid=\"response-body-text\"]')?.textContent.includes('PostMen OS QA')===true");
  await check("os-restart-real-http-retains-first-process-evidence",{requests:requests.length});
  await typeUI('[aria-label="Request URL"]',`http://127.0.0.1:${session.port}/json?os-discard-on-quit=1`);
  await wait("!!document.querySelector('.dirty-dot')");
  await os("menu",{path:["PostMen","Quit PostMen"]});
  await wait("!!document.querySelector('[role=dialog]')");
  await screen("os-discard-before-exit");
  await clickUI('[role=dialog] button',"Discard and Quit");
  await waitForExit();
  await check("os-native-quit-discard-actual-process-exit",{pid:session.pid,expectedSavedUrl:expected.url});
}
