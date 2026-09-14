// Check the production frontend, not either Vite development-only fixture.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { preview } from "vite";

const assets = resolve("frontend/dist/assets");
const names = await readdir(assets);
assert.ok(
  names.some((name) => name.endsWith(".js")),
  "Build frontend first",
);
for (const name of names.filter((name) => name.endsWith(".js"))) {
  const code = await readFile(resolve(assets, name), "utf8");
  for (const forbidden of [
    "127.0.0.1:43119",
    "alex@example.com",
    "Alex Morgan",
    "postmen.fixture.m2.v1",
    "Development fixture — browser storage only",
    "Unprepared fixture",
    "History fixture could not be saved",
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `Development data bundled: ${forbidden}`,
    );
  }
  assert.ok(!/ReferencePreview|M1Shell|memory-api|execution-api|visual-api/.test(name), "Fixture chunk was bundled");
}

const server = await preview({
  configFile: false,
  root: resolve("frontend"),
  preview: { host: "127.0.0.1", port: 1421, strictPort: true },
});
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:1421")
      external.push(request.url());
  });
  await page.goto("http://127.0.0.1:1421/?fixture=reference");
  await page.getByText("No collections yet").waitFor();
  assert.equal(
    await page.getByTestId("app-shell").getAttribute("data-fixture"),
    "false",
  );
  assert.equal(
    await page.getByTestId("app-shell").getAttribute("data-connection"),
    "browser",
  );
  assert.equal(
    await page.getByRole("button", { name: "UI preview", exact: true }).count(),
    0,
  );
  assert.equal(await page.getByTestId("request-pane").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Create Collection", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Change theme" }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await page.goto("http://127.0.0.1:1421/?fixture=workspace");
  await page.getByText("No collections yet").waitFor();
  assert.equal(await page.getByTestId("app-shell").getAttribute("data-fixture"), "false");
  assert.equal(await page.getByTestId("app-shell").getAttribute("data-ready"), "false");
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await page.goto("http://127.0.0.1:1421/?fixture=execution");
  await page.getByText("No collections yet").waitFor();
  assert.equal(await page.getByTestId("app-shell").getAttribute("data-fixture"), "false");
  assert.equal(await page.getByTestId("app-shell").getAttribute("data-ready"), "false");
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await page.goto("http://127.0.0.1:1421/?fixture=visual");
  await page.getByText("No collections yet").waitFor();
  assert.equal(await page.getByTestId("app-shell").getAttribute("data-fixture"), "false");
  assert.equal(await page.getByTestId("app-shell").getAttribute("data-ready"), "false");
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log("M4 production frontend passed: all four development fixtures excluded, no simulated database/HTTP/native connection, no external browser requests.");
} finally {
  await browser?.close();
  await new Promise((done, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : done())),
  );
}
