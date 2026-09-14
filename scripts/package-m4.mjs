// Local macOS build/launch only. No signing credentials, upload or publishing.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
async function run(args) {
  const started = Date.now();
  let output = "";
  const child = spawn("rtk", ["proxy", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
      process.stdout.write(data);
    });
  const code = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  return {
    command: args.join(" "),
    code,
    durationMs: Date.now() - started,
    output,
  };
}
const build = await run([
  "npm",
  "run",
  "tauri:build",
  "--",
  "--bundles",
  "app",
]);
await writeFile(
  "docs/milestones/M4/build.json",
  JSON.stringify({ builtAt: new Date().toISOString(), ...build }, null, 2) +
    "\n",
);
if (build.code !== 0) throw new Error("Production app build failed");
const smoke = await run(["node", "scripts/smoke-macos-bundle.mjs"]);
if (smoke.code !== 0) throw new Error("Production app smoke failed");
await writeFile(
  "docs/milestones/M4/release-bundle-smoke.json",
  JSON.stringify(JSON.parse(smoke.output), null, 2) + "\n",
);
