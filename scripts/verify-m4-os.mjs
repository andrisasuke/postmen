// Non-OS regression checks for the opt-in QA additions; preserve verification.json.
import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { destination } from "./m4-os-paths.mjs";
import { join } from "node:path";

const checks=[];
async function run(args){
  const started=Date.now();let output="";
  console.log(`Checking: ${args.join(" ")}`);
  const child=spawn("rtk",["proxy",...args],{stdio:["ignore","pipe","pipe"]});
  for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{output+=data;process.stdout.write(data)});
  const code=await new Promise((done,reject)=>{child.on("error",reject);child.on("close",done)});
  checks.push({command:args.join(" "),code,durationMs:Date.now()-started,output});
  await writeFile(join(destination,"verification.json"),JSON.stringify({checkedAt:new Date().toISOString(),scope:"Source regression, not OS acceptance",passed:checks.every(c=>c.code===0),checks},null,2)+"\n");
  if(code!==0)throw Error(`Failed: ${args.join(" ")}`);
}
for(const file of (await readdir("scripts")).filter(file=>file.endsWith(".mjs")))await run(["node","--check",`scripts/${file}`]);
for(const args of [
  ["swiftc","scripts/os-input.swift","-o","/tmp/postmen-m4-os-input"],
  ["cargo","fmt","--manifest-path","src-tauri/Cargo.toml","--check"],
  ["cargo","test","--manifest-path","src-tauri/Cargo.toml","--locked"],
  ["cargo","clippy","--manifest-path","src-tauri/Cargo.toml","--locked","--all-targets","--all-features","--","-D","warnings"],
  ["npm","run","typecheck"],["npm","run","lint"],["npm","test"],
  ["npm","run","test:production"],
])await run(args);
