// Audit stored native evidence and group repeated attempts into acceptance cases.
// A successful report generation does NOT mean the application passed OS QA.
import assert from "node:assert/strict";
import { referenceConfig } from "./reference/config.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { destination, retest } from "./m4-os-paths.mjs";

const root=destination;
const json=async name=>JSON.parse(await readFile(join(root,name),"utf8"));
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const events=(await readFile(join(root,"actions.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
const assertions=events.filter(e=>e.kind==="assertion");
const last=(name,selector)=>{
  const result=assertions.findLast(e=>e.name===name&&(!selector||e.detail?.selector===selector));
  assert.ok(result,`Missing evidence: ${name}`);
  return result;
};
const cases=[];
const add=(id,names,selector)=>{
  const evidence=names.map(name=>last(name,selector));
  cases.push({id,status:evidence.every(e=>e.passed)?"passed":"failed",evidence});
};
for(const name of [
  "os-cmd-s-saves-real-sqlite","os-native-send-request-menu","os-native-request-save-menu",
  "os-native-view-menu-and-cmd-b","os-native-about-menu-escape","os-cmd-q-cancel-preserves-draft",
  "os-red-close-button-cancel-preserves-draft","os-native-quit-menu-guard","os-quit-failed-save-keeps-window-draft-and-record",
  "os-file-picker-cancel-keeps-empty-field","os-file-picker-select-unicode-and-save-opaque-id",
  "os-file-picker-change-cancel-preserves-selection","os-picked-file-real-multipart-upload",
  "os-picked-file-missing-visible","os-picked-file-restored-recheck","os-accessibility-resize",
  "os-yellow-minimize-and-accessibility-restore","os-window-menu-zoom-unzoom",
  "os-green-fullscreen-and-native-menu-exit","os-native-next-previous-tab-menu",
  "os-cmd-shift-l-toggle-layout","os-native-toggle-layout-menu","os-cmd-q-save-all-actual-process-exit",
  "os-restart-saved-request-tabs-theme-layout","os-restart-maximized-same-monitor",
  "os-restart-real-http-retains-first-process-evidence","os-native-quit-discard-actual-process-exit",
])add(name,[name]);
for(const selector of ['[aria-label="Toggle sidebar"]','[aria-label="Request URL"]','[aria-label="Open requests"] [role=tab][aria-selected=true]'])
  add(`os-no-window-drag:${selector}`,["os-interactive-control-not-window-drag"],selector);
add("OS-01-send-accelerators",["os-cmd-return-url","os-cmd-keypad-enter-url","os-cmd-return-tab","os-cmd-keypad-enter-tab"]);
add("OS-02-tab-accelerators",["os-ctrl-tab-next-request","os-ctrl-shift-tab-previous-request"]);
add("OS-03-titlebar-drag-offset",["os-titlebar-pointer-drag-without-jump"]);
add("OS-04-unzoom-position-after-restart",["os-restart-unzoom-restores-normal-size-position"]);
if(retest)for(const name of ["os-send-autorepeat-does-not-submit-again","os-native-shortcuts-respect-modal-guard"])add(name,[name]);
for(const [id,reason] of [
  ["os-restore-multi-monitor-different-dpi","Only one DPR2 monitor is available"],
  [referenceConfig.windowedCaseId,"Available work area is 1440x869; PostMen fullscreen capture is supplemental, not a paired windowed golden"],
])cases.push({id,status:"blocked",reason});

const first=await json("first-start.json"),restored=await json("restore-start.json");
assert.notEqual(first.pid,restored.pid);
assert.equal(first.database,restored.database);
assert.equal(first.dataStoreIdentifier,restored.dataStoreIdentifier);
assert.ok(first.database.startsWith(join(resolve(tmpdir()),"postmen-m4-os-db-")));
for(const processSession of [first,restored])assert.throws(()=>process.kill(processSession.pid,0),error=>error.code==="ESRCH","QA PID must have exited");
assert.equal((await json("first-exit.json")).code,0);
assert.equal((await json("restore-exit.json")).code,0);
const environment=await json("environment.json");
assert.equal(environment.accessibility,true);
assert.equal(environment.screenCapture,true);
assert.equal(environment.postEvent,true);
const database=join(first.database,"postmen.sqlite3");
const query=sql=>JSON.parse(execFileSync("rtk",["proxy","sqlite3","-readonly","-json",database,sql],{encoding:"utf8"})||"[]");
const expected=await json("restart-expected.json");
const saved=query("SELECT id,name,url FROM requests ORDER BY position;");
assert.equal(saved.find(r=>r.name==="OS request").url,expected.url);
assert.deepEqual(query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'qa%';"),[]);
assert.equal(query("PRAGMA user_version;")[0].user_version,1);
assert.equal(query("PRAGMA integrity_check;")[0].integrity_check,"ok");
assert.deepEqual(await readFile(join(first.database,"upload-日本語.txt")),await readFile("tests/fixtures/m4-os-upload.txt"));
const postQuit={database,saved,discardDidNotPersistDraft:true,noQaTriggers:true,userVersion:1,integrity:"ok",uploadFixtureRestored:true,qaPidsExited:[first.pid,restored.pid]};
await writeFile(join(root,"post-quit-audit.json"),JSON.stringify(postQuit,null,2)+"\n");
const screenshots=[];
for(const file of (await readdir(root)).filter(f=>f.endsWith(".png")).sort()){
  const bytes=await readFile(join(root,file));
  assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  assert.ok(width>=1400&&height>=800,`Unexpectedly small native capture: ${file}`);
  screenshots.push({file,width,height,sha256:sha(bytes)});
}
const fullscreen=screenshots.find(s=>s.file==="os-native-fullscreen.png");
assert.deepEqual([fullscreen.width,fullscreen.height],[2880,1800]);
const checks=await json("verification.json");
assert.equal(checks.passed,true);
const sources=[];
for(const file of ["scripts/os-input.swift","scripts/start-m4-os.mjs","scripts/m4-os-paths.mjs","scripts/m4-os-driver.mjs","scripts/test-m4-os-core.mjs","scripts/test-m4-os-picker.mjs","scripts/test-m4-os-window.mjs","scripts/test-m4-os-shortcuts.mjs","scripts/test-m4-os-restart.mjs","scripts/test-m4-os-input-guards.mjs","scripts/verify-m4-os.mjs","scripts/report-m4-os.mjs","scripts/package-m4-os.mjs","scripts/smoke-macos-bundle.mjs","scripts/smoke-m3-native.mjs","src-tauri/src/native_smoke.rs","src-tauri/src/native_smoke_os.rs","src-tauri/src/lib.rs","src-tauri/src/lifecycle.rs","src-tauri/src/macos_input.rs","src-tauri/src/macos_window_state.rs","src-tauri/Cargo.toml","src-tauri/build.rs","src-tauri/capabilities/main-window.json","frontend/src/services/desktop.ts","frontend/src/app/WorkspaceApp.vue","frontend/src/components/layout/TitleBar.vue","frontend/src/components/layout/TitleBar.test.ts","package-lock.json","src-tauri/Cargo.lock"])
  sources.push({file,sha256:sha(await readFile(file))});
const counts=Object.fromEntries(["passed","failed","blocked"].map(status=>[status,cases.filter(c=>c.status===status).length]));
const report={checkedAt:new Date().toISOString(),milestone:"M4",evidenceValid:true,passed:counts.failed===0&&counts.blocked===0,counts,counting:"Grouped acceptance cases; not raw attempts, key variants, assertion totals or product parity",environment,processes:[first.pid,restored.pid],input:"CGEvent keyboard/pointer and AXPress native menus/buttons; DOM/SQLite only fixture setup and assertions; no DOM click/input substitute",cases,postQuit,screenshots,sources,
  supersededAttempts:retest?["Picker AX tree traversal timed out; screenshot/coordinate lookup now uses own-window metadata only; picker completed after retry","Premature concurrent shortcut driver lost a single-slot probe; rerun sequentially, and driver locking added before input","Between first and restored processes, event emission was narrowed to main and preference reading capped before allocation; shortcut checks rerun on the final build","Restart/unzoom assertions passed; subsequent HTTP-log read overlapped the fixture write and saw partial JSON. Added bounded JSON-read retry, then finish-only passed actual HTTP and Discard/Quit without repeating or replacing restart evidence"]:["os-green-fullscreen-enter-exit tried auto-hidden green control / unregistered Ctrl+Cmd+F; actual native menu entry/exit tested later","Initial previous-tab assertion did not establish a different starting tab; replaced by explicit before/expected checks on restored PID","Restart HTTP assertion initially read the preceding response too soon; resumed after polling actual loopback request count","Watchdog-expired pre-reconnect run archived separately and excluded"],
  observations:["Native fullscreen menu keeps Enter Full Screen label while already fullscreen","Native traffic lights have AX top offset 0 inside 36px custom titlebar; visual review pending"],
  limitations:["OS events are automated native inputs, not a human hand on hardware","QA build is opt-in native-smoke, not normal release-bundle OS acceptance",retest?"Only authorized OS-01–04 fixes; no migration, legacy DB access, commit/push or M5":"No production fix, migration, legacy DB access, commit/push or M5","Signing/notarization, Windows/Linux, full visual acceptance and GAP-01–10/ID-01 remain open"]};
await writeFile(join(root,"results.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({evidenceValid:true,passed:report.passed,counts,screenshots:screenshots.length},null,2));
