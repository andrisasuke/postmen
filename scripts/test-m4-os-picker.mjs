import assert from "node:assert/strict";
import { copyFile, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { session, destination, probe, os, wait, clickUI, screen, check } from "./m4-os-driver.mjs";
const uploadId=session.ready.workspace.requests.find(r=>r.name==="OS upload").id;
const file=join(session.database,"upload-日本語.txt");
await copyFile("tests/fixtures/m4-os-upload.txt",file);
await clickUI(`[data-request-tab="${uploadId}"]`);
await wait("document.querySelector('.multipart-editor')!==null");
await clickUI(".file-field button","Choose file");
await delay(700);
await os("press",{role:"AXButton",name:"Cancel"});
await wait("Array.from(document.querySelectorAll('.file-field button')).some(e=>e.textContent==='Choose file'&&!e.disabled)");
assert.equal((await probe("request",{requestId:uploadId})).formData[0].attachmentId,null);
await check("os-file-picker-cancel-keeps-empty-field");

async function selectFile(){
  await clickUI(".file-field button");
  await delay(600);
  await os("key",{code:5,modifiers:["cmd","shift"]});
  await delay(400);
  await os("type",{text:file});
  await os("key",{code:36});
  await delay(650);
  await screen("os-file-picker-selected");
  await os("press",{role:"AXButton",name:"Open"});
  await wait("document.querySelector('.file-field')?.textContent.includes('upload-日本語.txt')===true");
}
await selectFile();
await os("key",{code:1,modifiers:["cmd"]});
await wait("!document.querySelector('.dirty-dot')");
const stored=await probe("request",{requestId:uploadId});
assert.match(stored.formData[0].attachmentId,/^[0-9a-f-]{36}$/);
await check("os-file-picker-select-unicode-and-save-opaque-id",{attachmentId:stored.formData[0].attachmentId});
await clickUI(".file-field button","Change file");
await delay(600);
await os("press",{role:"AXButton",name:"Cancel"});
await wait("document.querySelector('.file-field')?.textContent.includes('upload-日本語.txt')===true && !document.querySelector('.file-field button')?.disabled");
assert.equal((await probe("request",{requestId:uploadId})).formData[0].attachmentId,stored.formData[0].attachmentId);
await check("os-file-picker-change-cancel-preserves-selection");
await clickUI("button","Send");
await wait("document.querySelector('[data-testid=\"response-body-text\"]')?.textContent.includes('PostMen OS QA')===true");
const requests=JSON.parse(await readFile(join(destination,"requests.json"),"utf8"));
const sent=requests.findLast(r=>r.method==="POST"&&r.path==="/upload");
assert.ok(sent?.contentType.startsWith("multipart/form-data; boundary="));
assert.ok(sent.body.includes(await readFile(file,"utf8")));
assert.ok(sent.body.includes('name="file"'));
await screen("os-upload-response");
await check("os-picked-file-real-multipart-upload",{contentType:sent.contentType,bytes:Buffer.byteLength(sent.body)});

await rename(file,file+".held");
try {
  await clickUI("button","Check files");
  await wait("document.querySelector('.file-field')?.textContent.includes('file missing')===true");
  await screen("os-picked-file-missing");
  await check("os-picked-file-missing-visible");
} finally {await rename(file+".held",file);}
await clickUI("button","Check files");
await wait("document.querySelector('.file-field')?.textContent.includes('file missing')===false");
await check("os-picked-file-restored-recheck");
console.log("OS picker tests completed");
