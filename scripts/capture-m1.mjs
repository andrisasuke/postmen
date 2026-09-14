// Frontend-only visual evidence; native Tauri smoke is reported separately.
import assert from "node:assert/strict";
import { referenceConfig } from "./reference/config.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const output = resolve("docs/milestones/M1/screenshots");
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 840 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const captures = [];
const capture = async (name) => {
  await page.mouse.move(720, 16);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const bytes = await page.screenshot({
    path: resolve(output, `${name}.png`),
    animations: "disabled",
  });
  const metrics = await page.evaluate(() => {
    const selectors = [
      ".app-titlebar",
      ".status-bar",
      '[data-testid="sidebar"]',
      ".query-url-wrapper",
      '[data-testid="request-pane"]',
      '[data-testid="response-pane"]',
      ".pane-divider",
      ".editor-tabs",
      ".code-line code",
      '[role="dialog"]',
    ];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dpr: devicePixelRatio,
      theme: document.documentElement.dataset.theme,
      elements: selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)].slice(0, 2).map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            selector,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            font: style.fontFamily,
            fontSize: style.fontSize,
            color: style.color,
            background: style.backgroundColor,
          };
        }),
      ),
    };
  });
  captures.push({
    name,
    file: `screenshots/${name}.png`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...metrics,
  });
  console.log(`Captured ${name}`);
};
const theme = async (name) => {
  await page.getByRole("button", { name: "Change theme" }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
};
try {
  await page.goto("http://127.0.0.1:1420/");
  await page.getByText("No collections yet").waitFor();
  await capture("empty-light");
  await theme("Dark");
  await capture("empty-dark");
  await page.getByRole("button", { name: "Change theme" }).click();
  await capture("theme-dropdown-dark");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "UI preview", exact: true }).click();
  await page.getByTestId("request-pane").waitFor();
  await capture("json-body-response-dark");
  await theme("Light");
  await capture("json-body-response-light");
  await theme("Dark");
  await page.getByRole("button", { name: "HTTP method", exact: true }).click();
  await capture("method-dropdown-dark");
  await page.keyboard.press("Escape");
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "POST Create user", exact: true })
    .click({ button: "right" });
  await capture("context-menu-dark");
  await page.getByRole("menuitem", { name: "Delete preview request" }).click();
  await capture("delete-request-modal-dark");
  await page.keyboard.press("Escape");
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "GET List users", exact: true })
    .click();
  await capture("params-dark");
  await page
    .getByRole("button", { name: "Toggle response layout", exact: true })
    .click();
  await capture("vertical-layout-dark");
  await page
    .getByRole("button", { name: "Toggle response layout", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Toggle sidebar", exact: true })
    .click();
  await capture("sidebar-collapsed-dark");
  await page.setViewportSize({ width: 700, height: 400 });
  await capture("small-window-dark");
  assert.deepEqual(errors, [], "Frontend runtime errors during capture");

  const reference = JSON.parse(
    await readFile(`${referenceConfig.directory}/captures.json`, "utf8"),
  );
  const comparison = [];
  for (const name of ["json-body-response-dark", "json-body-response-light"]) {
    const ours = captures.find((c) => c.name === name);
    const theirs = reference.captures.find((c) => c.name === name);
    for (const selector of [
      ".app-titlebar",
      ".status-bar",
      '[data-testid="sidebar"]',
      ".query-url-wrapper",
      '[data-testid="request-pane"]',
      '[data-testid="response-pane"]',
    ]) {
      const a = ours.elements.find((e) => e.selector === selector);
      const b = theirs.elements.find((e) => e.selector === selector);
      assert.ok(a && b, `${name}: missing region ${selector}`);
      const delta = Object.fromEntries(
        ["x", "y", "width", "height"].map((key) => [
          key,
          Math.abs(a[key] - b[key]),
        ]),
      );
      assert.ok(
        Object.values(delta).every((value) => value <= 1),
        `${name} ${selector}: geometry differs by >1px`,
      );
      comparison.push({ name, selector, delta });
    }
  }
  await writeFile(
    resolve(output, "../captures.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        engine: `Chromium ${browser.version()}`,
        nativeDesktop: false,
        captures,
        comparison,
        notes: [
          "Dev fixtures only. Production contains no demo requests or responses.",
          "Geometry comparison is not full-image pixel parity; see M1 report for scope and visual gaps.",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Verified ${comparison.length} light/dark shell regions against reference geometry`,
  );
} finally {
  await browser.close();
}
