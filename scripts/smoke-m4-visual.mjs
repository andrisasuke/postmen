// Actual Tauri, isolated SQLite/WebKit profile, matching loopback reference fixture.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
assert.equal(process.platform, "darwin");
assert.ok((await fetch("http://127.0.0.1:1420")).ok, "Start npm run dev first");
const database = await mkdtemp(join(tmpdir(), "postmen-m4-db-")),
  output = await mkdtemp(join(tmpdir(), "postmen-m4-visual-"));
const identifier = `com.postmen.nativeqa.m4${Date.now()}`,
  requests = [],
  timers = new Set();
const server = createServer((request, response) => {
  request.resume();
  requests.push({ method: request.method, path: request.url });
  const reply = () => {
    response.writeHead(request.url?.startsWith("/error") ? 500 : 200, {
      "Content-Type": "application/json",
      "X-Reference": "PostMen M0",
      "Cache-Control": "no-store",
      Date: "Sat, 05 Sep 2026 00:00:00 GMT",
    });
    response.end(
      JSON.stringify(
        {
          success: !request.url?.startsWith("/error"),
          data: {
            id: 42,
            name: "Alex Morgan",
            email: "alex@example.com",
            active: true,
          },
        },
        null,
        2,
      ),
    );
  };
  if (request.url?.startsWith("/slow")) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      reply();
    }, 15000);
    timers.add(timer);
    response.on("close", () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  } else reply();
});
await new Promise((done, reject) => {
  server.once("error", reject);
  server.listen(43119, "127.0.0.1", done);
});
try {
  const dataStoreIdentifier = randomUUID();
  const config = {
    identifier,
    app: {
      windows: [
        {
          label: "main",
          title: "PostMen M4 Visual QA",
          width: 1440,
          height: 840,
          minWidth: 700,
          minHeight: 400,
          center: true,
          create: false,
          incognito: false,
          titleBarStyle: "Overlay",
          hiddenTitle: true,
          trafficLightPosition: { x: 12, y: 20 },
          dragDropEnabled: false,
        },
      ],
    },
  };
  const child = spawn(
    resolve("node_modules/.bin/tauri"),
    [
      "dev",
      "--config",
      "src-tauri/tauri.smoke.conf.json",
      "--config",
      JSON.stringify(config),
      "--features",
      "native-smoke",
      "--no-watch",
    ],
    {
      cwd: resolve("."),
      stdio: "inherit",
      env: {
        ...process.env,
        POSTMEN_SMOKE_DATA_STORE_ID: dataStoreIdentifier,
        POSTMEN_SMOKE_MILESTONE: "M4",
        POSTMEN_SMOKE_DIR: output,
        POSTMEN_SMOKE_DATABASE_DIR: database,
      },
    },
  );
  const watchdog = setTimeout(() => child.kill("SIGTERM"), 360000);
  let code;
  try {
    code = await new Promise((done, reject) => {
      child.on("error", reject);
      child.on("close", done);
    });
  } finally {
    clearTimeout(watchdog);
  }
  assert.equal(code, 0, "Native visual process failed");
  const report = JSON.parse(
    await readFile(join(output, "native-smoke.json"), "utf8"),
  );
  assert.equal(report.nativeDesktop, true);
  assert.ok(
    requests.some((r) => r.method === "POST" && r.path === "/users"),
    "No actual POST /users",
  );
  const destination = resolve("docs/milestones/M4/native-visual");
  await mkdir(destination, { recursive: true });
  for (const capture of report.captures) {
    execFileSync(
      "sips",
      [
        "-s",
        "format",
        "png",
        join(output, `${capture.name}.tiff`),
        "--out",
        join(destination, capture.file),
      ],
      { stdio: "ignore" },
    );
    const bytes = await readFile(join(destination, capture.file));
    capture.sha256 = createHash("sha256").update(bytes).digest("hex");
    capture.png = {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
    assert.equal(
      capture.png.width,
      capture.viewport.width * capture.devicePixelRatio,
    );
    assert.equal(
      capture.png.height,
      capture.viewport.height * capture.devicePixelRatio,
    );
  }
  await writeFile(
    join(destination, "captures.json"),
    JSON.stringify(
      {
        ...report,
        capturedAt: new Date().toISOString(),
        identifier,
        dataStoreIdentifier,
        database,
        output,
        requests,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        destination,
        initial: report.initial.viewport,
        resized: report.afterExactResize.viewport,
        captures: report.captures.length,
        additionalSizes: report.additionalSizes,
      },
      null,
      2,
    ),
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
