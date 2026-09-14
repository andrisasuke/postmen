// Diagnose real native accelerators; passive DOM listeners only observe input.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { session, destination, probe, os, clickUI, wait, check } from "./m4-os-driver.mjs";

const requestId=session.ready.workspace.requests.find(r=>r.name==="OS request").id;
await clickUI(`[data-request-tab="${requestId}"]`);
await wait(`document.querySelector('[data-request-tab="${requestId}"]')?.getAttribute('aria-selected')==='true'`);
await probe("probe",{expression:"globalThis.__postmenOsKeyDiagnostics=[]; document.addEventListener('keydown',e=>globalThis.__postmenOsKeyDiagnostics.push({key:e.key,code:e.code,meta:e.metaKey,ctrl:e.ctrlKey,trusted:e.isTrusted,target:e.target.getAttribute?.('aria-label')??e.target.tagName}),true); true"});
const count=async()=>JSON.parse(await readFile(join(destination,"requests.json"),"utf8")).length;
const results=[];
for(const [focus,selector] of [["url",'[aria-label="Request URL"]'],["tab",`[data-request-tab="${requestId}"]`]]){
  for(const code of [36,76]){
    await clickUI(selector);
    const before=await count();
    await os("key",{code,modifiers:["cmd"]});
    await delay(1500);
    const after=await count();
    const keys=await probe("probe",{expression:"globalThis.__postmenOsKeyDiagnostics.slice(-4)"});
    const result={focus,code,before,after,keys,sent:after===before+1};
    results.push(result);
    await check(`os-cmd-${code===36?"return":"keypad-enter"}-${focus}`,result,result.sent);
  }
}
const before=await count();
await os("menu",{path:["View","Send Request"]});
await delay(800);
assert.equal(await count(),before+1);
await check("os-native-send-control-after-shortcut-diagnostics");
const active=()=>probe("probe",{expression:"document.querySelector('[aria-label=\"Open requests\"] [aria-selected=true]')?.dataset.requestTab"});
const uploadId=session.ready.workspace.requests.find(r=>r.name==="OS upload").id;
await clickUI(`[data-request-tab="${requestId}"]`);
assert.equal(await active(),requestId);
await os("key",{code:48,modifiers:["ctrl"]});
await delay(200);
await check("os-ctrl-tab-next-request",{before:requestId,active:await active(),expected:uploadId},(await active())===uploadId);
// Establish a different starting tab even if the forward accelerator failed.
await clickUI(`[data-request-tab="${uploadId}"]`);
assert.equal(await active(),uploadId);
await os("key",{code:48,modifiers:["ctrl","shift"]});
await delay(200);
await check("os-ctrl-shift-tab-previous-request",{before:uploadId,active:await active(),expected:requestId},(await active())===requestId);
await clickUI(`[data-request-tab="${requestId}"]`);
await os("menu",{path:["Request","Next Request Tab"]});
await delay(200);
assert.equal(await active(),uploadId);
await os("menu",{path:["Request","Previous Request Tab"]});
await delay(200);
assert.equal(await active(),requestId);
await check("os-native-next-previous-tab-menu");
const settings=()=>probe("probe",{expression:"JSON.parse(localStorage.getItem('postmen.shell.settings.v1'))"});
const layoutBefore=(await settings()).orientation;
await os("key",{code:37,modifiers:["cmd","shift"]});
await delay(200);
await check("os-cmd-shift-l-toggle-layout",{before:layoutBefore,after:(await settings()).orientation},(await settings()).orientation!==layoutBefore);
await os("menu",{path:["View","Toggle Response Layout"]});
await delay(200);
assert.equal((await settings()).orientation,layoutBefore);
await check("os-native-toggle-layout-menu");
await writeFile(join(destination,"shortcut-diagnostics.json"),JSON.stringify({at:new Date().toISOString(),pid:session.pid,results},null,2)+"\n");
