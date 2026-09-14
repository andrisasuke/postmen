// Real WorkspaceApp, DEV-only in-memory dataset. NOT native HTTP/SQLite evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, webkit } from "playwright";

const phase = process.argv.includes("--before") ? "before" : "after";
for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
  const output = resolve(`docs/milestones/M4/${phase}/${engine}`);
  await mkdir(output, { recursive: true });
  const browser = await launcher.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 840 },
      deviceScaleFactor: 2,
      colorScheme: "light",
    });
    const page = await context.newPage();
    const errors = [],
      external = [],
      captures = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (new URL(r.url()).hostname !== "127.0.0.1") external.push(r.url());
    });
    const button = (name) => page.getByRole("button", { name, exact: true });
    const theme = async (name) => {
      await button("Change theme").click();
      await page.getByRole("menuitemradio", { name, exact: true }).click();
    };
    const tree = (name) =>
      page.getByTestId("sidebar").getByRole("button", { name, exact: true });
    const section = async (pane, name) =>
      page
        .getByRole("tablist", { name: `${pane} sections` })
        .getByRole("tab", { name })
        .click();
    const send = async () => {
      await button("Send").click();
      await page.getByTestId("response-body-text").waitFor();
    };
    const capture = async (name) => {
      await page.mouse.move(720, 16);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      const metrics = await page.evaluate(() => ({
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
        theme: document.documentElement.dataset.theme,
        elements: [
          ".app-titlebar",
          ".status-bar",
          '[data-testid="sidebar"]',
          ".collection-header",
          ".request-tabs-bar",
          ".query-url-wrapper",
          ".query-url-input",
          '[data-testid="request-pane"]',
          '[data-testid="response-pane"]',
          ".pane-divider",
          ".pane-toolbar",
          ".cm-editor",
          ".cm-lineNumbers .cm-gutterElement",
          ".cm-line",
          "table",
          "table th",
          "table tbody tr",
          '[role="dialog"]',
          '[role="menu"]',
          '[role="listbox"]',
        ].flatMap((selector) =>
          [...document.querySelectorAll(selector)].flatMap((e) => {
            const r = e.getBoundingClientRect(),
              s = getComputedStyle(e);
            return r.width && r.height
              ? [
                  {
                    selector,
                    text: e.textContent?.trim().slice(0, 80),
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: r.height,
                    font: s.fontFamily,
                    fontSize: s.fontSize,
                    lineHeight: s.lineHeight,
                    color: s.color,
                    background: s.backgroundColor,
                  },
                ]
              : [];
          }),
        ),
      }));
      const bytes = await page.screenshot({
        path: resolve(output, `${name}.png`),
        animations: "disabled",
      });
      captures.push({
        name,
        file: `${name}.png`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...metrics,
      });
      console.log(`${phase}/${engine}: ${name}`);
    };
    await page.goto("http://127.0.0.1:1420/?fixture=visual&empty");
    await page.getByText("No collections yet").waitFor();
    await capture("empty-light");
    await theme("Dark");
    await capture("empty-dark");
    await button("Change theme").click();
    await capture("theme-dropdown-dark");
    await page.keyboard.press("Escape");
    await button("Create collection").click();
    await capture("create-collection-inline-dark");
    await button("Cancel").click();
    await page.goto("http://127.0.0.1:1420/?fixture=visual");
    await tree("Assets").click(); // Match collapsed Assets in the reference.
    await tree("GET List users").click();
    await page.getByTestId("request-pane").waitFor();
    await capture("params-dark");
    await button("HTTP method").click();
    await capture("method-dropdown-dark");
    await page.keyboard.press("Escape");
    await send();
    await capture("response-dark");
    await section("Response", /^Headers/);
    await section("Request", /^Headers/);
    await capture("headers-dark");
    await tree("POST Create user").click();
    await page.getByTestId("json-editor-input").waitFor();
    await send();
    await capture("json-body-response-dark");
    await capture("json-body-response-dark-repeat");
    if (phase === "after") {
      await page
        .getByRole("combobox", { name: "Body type", exact: true })
        .click();
      await capture("body-type-dropdown-dark");
      await page.keyboard.press("Escape");
      await page
        .getByRole("combobox", { name: "Response format", exact: true })
        .click();
      await capture("response-format-dropdown-dark");
      await page.keyboard.press("Escape");
      await page.getByLabel("Request URL", { exact: true }).focus();
      await capture("focused-url-dark");
      await page
        .getByRole("tablist", { name: "Request sections" })
        .getByRole("tab", { name: "Headers", exact: false })
        .hover();
      // Capture the hover before the general capture helper moves the pointer.
      await page.screenshot({
        path: resolve(output, "hover-request-tab-dark.png"),
        animations: "disabled",
      });
    }
    await theme("Light");
    await capture("json-body-response-light");
    await capture("json-body-response-light-repeat");
    if (phase === "after") {
      await page.getByLabel("Request URL", { exact: true }).focus();
      await capture("focused-url-light");
    }
    await theme("Dark");
    await tree("Assets").click();
    await tree("POST Upload asset").click();
    await capture("multipart-dark");
    await tree("GET Server error").click();
    await send();
    await capture("server-error-dark");
    await tree("GET Slow response").click();
    await button("Send").click();
    await button("Cancel request").waitFor();
    await capture("loading-dark");
    await button("Cancel request").click();
    await tree("POST Create user").click();
    await tree("POST Create user").click({ button: "right" });
    await capture("request-context-menu-dark");
    await page
      .getByRole("menuitem", { name: "Delete request", exact: true })
      .click();
    await capture("delete-request-modal-dark");
    await button("Cancel").click();
    await button("Toggle response layout").click();
    await capture("vertical-layout-dark");
    await button("Toggle response layout").click();
    await button("Toggle sidebar").click();
    await capture("sidebar-collapsed-dark");
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
      [700, 400],
    ]) {
      await page.setViewportSize({ width, height });
      await capture(`viewport-${width}x${height}-dark`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await writeFile(
      resolve(output, "captures.json"),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          engine: `${engine} ${browser.version()}`,
          nativeDesktop: false,
          fixture:
            "DEV visual, real WorkspaceApp; deterministic simulated execution",
          phase,
          errors,
          external,
          captures,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await browser.close();
  }
}
