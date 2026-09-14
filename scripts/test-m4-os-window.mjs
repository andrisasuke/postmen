import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { destination, probe, os, wait, screen, check } from "./m4-os-driver.mjs";
const state=()=>probe("state");
const windowInfo=async()=> (await os("windows")).windows.find(w=>w.kCGWindowLayer===0&&w.kCGWindowIsOnscreen&&w.kCGWindowAlpha===1&&w.kCGWindowBounds.Width>=700&&w.kCGWindowBounds.Height>=400);
await os("size",{width:1000,height:650});
await os("position",{x:100,y:90});
await wait("innerWidth===1000 && innerHeight===650");
await check("os-accessibility-resize");
let before=await state(),frame=(await windowInfo()).kCGWindowBounds;
assert.equal(await probe("probe",{expression:"document.elementFromPoint(350,18)?.hasAttribute('data-tauri-drag-region')"}),true);
await os("drag",{x:frame.X+350,y:frame.Y+18,toX:frame.X+430,toY:frame.Y+63});
await delay(350);
let after=await state();
const dragAccurate=Math.abs(after.position.x-before.position.x-160)<=4 && Math.abs(after.position.y-before.position.y-90)<=4;
await screen("os-titlebar-drag");
await check("os-titlebar-pointer-drag-without-jump",{expectedPhysicalDelta:{x:160,y:90},before:before.position,after:after.position},dragAccurate);
await os("position",{x:100,y:90});
for(const selector of ['[aria-label="Toggle sidebar"]','[aria-label="Request URL"]','[aria-label="Open requests"] [role=tab][aria-selected=true]']){
  before=await state();frame=(await windowInfo()).kCGWindowBounds;
  const point=await probe("probe",{expression:`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`});
  await os("drag",{x:frame.X+point.x,y:frame.Y+point.y,toX:frame.X+point.x+25,toY:frame.Y+point.y+8});
  after=await state();
  assert.deepEqual(after.position,before.position);
  await check("os-interactive-control-not-window-drag",{selector});
}
await os("press",{subrole:"AXMinimizeButton"});
await delay(500);
assert.equal((await state()).minimized,true);
await os("restore");
await delay(450);
assert.equal((await state()).minimized,false);
await screen("os-minimize-restored");
await check("os-yellow-minimize-and-accessibility-restore");

before=await state();
await os("menu",{path:["Window","Zoom"]});
await delay(700);
after=await state();
assert.equal(after.maximized,true);
await screen("os-native-zoom");
await os("menu",{path:["Window","Zoom"]});
await delay(650);
assert.equal((await state()).maximized,false);
await check("os-window-menu-zoom-unzoom",{before:before.geometry.viewport,zoomed:after.geometry.viewport});

await os("press",{subrole:"AXFullScreenButton"});
await delay(2200);
after=await state();
assert.equal(after.fullscreen,true);
await screen("os-native-fullscreen");
await writeFile(join(destination,"fullscreen.json"),JSON.stringify({state:after,note:"Native OS fullscreen, not windowed reference parity capture"},null,2)+"\n");
// macOS exposes this toggle with an unchanged Enter label in this runtime.
// Ctrl+Cmd+F is not registered by PostMen; it is not our exit mechanism.
await os("menu",{path:["View","Enter Full Screen"]});
await delay(1800);
after=await state();
assert.equal(after.fullscreen,false);
await check("os-green-fullscreen-and-native-menu-exit");
console.log("OS window tests completed");
