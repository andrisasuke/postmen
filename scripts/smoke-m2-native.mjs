// Two real native processes share one disposable QA database. No legacy data.
// Start npm run dev first. All evidence is generated outside the workspace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.platform, "darwin", "Native QA currently supports macOS only");
assert.ok((await fetch("http://127.0.0.1:1420")).ok, "Start npm run dev first");
const database = await mkdtemp(join(tmpdir(), "postmen-m2-db-"));
const reports = [];
for (const phase of ["first", "restore"]) {
  const output = await mkdtemp(join(tmpdir(), `postmen-m2-${phase}-`));
  const child = spawn(resolve("node_modules/.bin/tauri"), ["dev", "--config", "src-tauri/tauri.smoke.conf.json", "--features", "native-smoke", "--no-watch"], {
    cwd: resolve("."), stdio: "inherit", env: { ...process.env, POSTMEN_SMOKE_DIR: output, POSTMEN_SMOKE_DATABASE_DIR: database, POSTMEN_SMOKE_RESTORE: phase === "restore" ? "1" : "0" },
  });
  const result = await new Promise((done, reject) => { child.on("error", reject); child.on("close", (code) => done(code)); });
  assert.equal(result, 0, `Native ${phase} process failed`);
  const report = JSON.parse(await readFile(join(output, "native-smoke.json"), "utf8"));
  assert.equal(report.nativeDesktop, true);
  assert.equal(report.milestone, "M2");
  assert.equal(report.restoreProcess, phase === "restore");
  reports.push({ phase, output, checks: report.checks });
}
console.log(JSON.stringify({ passed: true, database, reports, note: "Temporary QA database and captures retained for inspection. No normal/legacy DB seeded." }, null, 2));
