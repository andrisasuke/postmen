// Separate target directory: retain the pre-fix release bundle and its evidence.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root="docs/milestones/M4/os-input-fixed";
async function run(args,env=process.env){
  const started=Date.now();let output="";
  const child=spawn("rtk",["proxy",...args],{stdio:["ignore","pipe","pipe"],env});
  for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{output+=data;process.stdout.write(data)});
  const code=await new Promise((done,reject)=>{child.on("error",reject);child.on("close",done)});
  return {command:args.join(" "),code,durationMs:Date.now()-started,output};
}
const build=await run(["npm","run","tauri:build","--","--bundles","app"],{...process.env,CARGO_TARGET_DIR:resolve("src-tauri/target/os-fixed")});
await writeFile(root+"/build.json",JSON.stringify({builtAt:new Date().toISOString(),...build},null,2)+"\n");
if(build.code!==0)throw Error("OS-fixed production build failed");
const smoke=await run(["node","scripts/smoke-macos-bundle.mjs","--os-fixed"]);
if(smoke.code!==0)throw Error("OS-fixed release smoke failed");
await writeFile(root+"/release-bundle-smoke.json",JSON.stringify(JSON.parse(smoke.output),null,2)+"\n");
