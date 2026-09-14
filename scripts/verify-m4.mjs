import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const checks=[];
async function run(args) {
  const started=Date.now();let output="";
  console.log(`\nChecking: ${args.join(" ")}`);
  const child=spawn("rtk",["proxy",...args],{stdio:["ignore","pipe","pipe"]});
  for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{output+=data;process.stdout.write(data);});
  const code=await new Promise((done,reject)=>{child.on("error",reject);child.on("close",done);});
  checks.push({command:args.join(" "),code,durationMs:Date.now()-started,output});
  await writeFile("docs/milestones/M4/verification.json",JSON.stringify({checkedAt:new Date().toISOString(),passed:checks.every(c=>c.code===0),checks},null,2)+"\n");
  if(code!==0)throw new Error(`Check failed: ${args.join(" ")}`);
}
for(const args of [
  ["npm","run","typecheck"], ["npm","run","lint"], ["npm","test"],
  ["cargo","fmt","--manifest-path","src-tauri/Cargo.toml","--check"],
  ["cargo","test","--manifest-path","src-tauri/Cargo.toml","--locked"],
  ["cargo","clippy","--manifest-path","src-tauri/Cargo.toml","--locked","--all-targets","--all-features","--","-D","warnings"],
  ["npm","run","test:e2e"], ["npm","run","test:production"],
  ["node","scripts/reference/verify-reference.mjs"], ["node","scripts/audit-notices.mjs"],
])await run(args);
