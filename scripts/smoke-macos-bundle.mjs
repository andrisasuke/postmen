// Launch/inspect/stop only the child process created here. No Accessibility.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

assert.equal(process.platform, "darwin", "This smoke test supports macOS only");
const bundle = resolve(
  process.argv.includes("--os-fixed")
    ? "src-tauri/target/os-fixed/release/bundle/macos/PostMen.app/Contents"
    : "src-tauri/target/release/bundle/macos/Postmen.app/Contents",
);
const executable = resolve(bundle, process.argv.includes("--os-fixed")
  ? "MacOS/postmen-desktop"
  : "MacOS/Postmen");
const bytes = await readFile(executable);
assert.ok(
  !bytes.includes(Buffer.from("POSTMEN_NATIVE_SMOKE_")),
  "Do not ship a QA-feature build",
);
assert.ok(!bytes.includes(Buffer.from("POSTMEN_SMOKE_MILESTONE")), "Do not ship OS QA hooks");
const licenses = (await readdir("licenses")).filter((name) =>
  name.endsWith(".txt"),
);
for (const name of licenses) {
  assert.deepEqual(
    await readFile(resolve(bundle, "Resources/licenses", name)),
    await readFile(resolve("licenses", name)),
    `Missing or outdated bundled license: ${name}`,
  );
}
assert.deepEqual(
  await readFile(resolve(bundle, "Resources/THIRD_PARTY_NOTICES.md")),
  await readFile("THIRD_PARTY_NOTICES.md"),
);

const app = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] });
let spawnError;
app.on("error", (error) => {
  spawnError = error;
});
let stderr = "";
app.stderr.on("data", (data) => {
  stderr += data.toString();
});
app.stdout.resume();
const closed = new Promise((done) => app.on("close", done));
try {
  await delay(3000);
  if (spawnError) throw spawnError;
  assert.equal(app.exitCode, null, `App exited early: ${stderr}`);
  assert.equal(app.signalCode, null, "App terminated early");
  const { stdout } = await promisify(execFile)(
    "swift",
    ["scripts/native-window-info.swift", String(app.pid)],
    { timeout: 30000 },
  );
  const windows = JSON.parse(stdout).filter(
    (window) => window.kCGWindowOwnerPID === app.pid,
  );
  assert.ok(windows.length > 0, "Bundle has no visible native window");
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        kind: "normal release bundle launch and resource checks",
        executable,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bundledLicenses: licenses,
        windows,
        stderr,
        limitations: [
          "No renderer assertions here. Native IPC/rendering is tested independently by the opt-in debug smoke.",
          "This test stops its own child with SIGTERM; it is not an OS Quit-menu test.",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (app.exitCode === null && app.signalCode === null) app.kill("SIGTERM");
  await closed;
}
