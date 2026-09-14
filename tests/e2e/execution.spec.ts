import { expect, test, type Page } from "@playwright/test";
import { select, menuAction } from "./controls";
async function request(page: Page, name = "First") {
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "Execution QA", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "New request", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "New Request" });
  await dialog.getByLabel("Request Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: `GET ${name}`, exact: true }),
  ).toBeVisible();
}
async function send(page: Page, path: string) {
  await page
    .getByLabel("Request URL", { exact: true })
    .fill(`http://fixture.test/${path}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  await page.goto("/?fixture=execution");
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await page
    .getByRole("button", { name: "Create collection", exact: true })
    .click();
  await page.getByLabel("Item name", { exact: true }).fill("Execution QA");
  await page
    .getByRole("button", { name: "Confirm create collection", exact: true })
    .click();
  await request(page);
});
test("Send displays inert searchable formatted/raw response and duplicate headers", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await send(page, "json");
  const response = page.getByTestId("response-pane");
  await expect(response).toContainText("200 OK");
  await expect(response.getByTestId("response-body-text")).toContainText(
    "日本語",
  );
  await expect(
    page
      .getByRole("tablist", { name: "Open requests" })
      .getByLabel("Unsaved changes"),
  ).toBeVisible();
  await select(page, "Response format", "Raw");
  await expect(response.getByTestId("response-body-text")).toContainText(
    '{"fixture":true',
  );
  await menuAction(page, "Response actions", "Search response");
  await response.locator('.cm-search input[name="search"]').fill("日本語");
  await response.locator('.cm-search input[name="search"]').press("Enter");
  await expect(response.locator(".cm-searchMatch").first()).toBeVisible();
  await menuAction(page, "Response actions", "Copy response");
  await expect(response.locator('[role="status"]')).toContainText(
    /copied|Clipboard unavailable/,
  );
  await page
    .getByRole("tablist", { name: "Response sections" })
    .getByRole("tab", { name: /Headers/ })
    .click();
  await expect(
    page.getByRole("table", { name: "Response headers" }).locator("tbody tr"),
  ).toHaveCount(2);
  await expect(response).toContainText("first");
  await expect(response).toContainText("second");
  await page
    .getByRole("tablist", { name: "Response sections" })
    .getByRole("tab", { name: "Response", exact: true })
    .click();
  await select(page, "Response format", "JSON");
  for (const theme of ["Light", "Dark"]) {
    await page
      .getByRole("button", { name: "Change theme", exact: true })
      .click();
    await page.getByRole("menuitemradio", { name: theme, exact: true }).click();
    await page.screenshot({
      path: `docs/milestones/M4/browser-${info.project.name}-${theme.toLowerCase()}.png`,
    });
  }
  expect(errors).toEqual([]);
});
test("HTML stays text; HTTP errors, empty, timeout and truncation are distinct", async ({
  page,
}) => {
  const response = page.getByTestId("response-pane");
  await send(page, "html");
  await expect(response.getByTestId("response-body-text")).toContainText(
    "<script>",
  );
  expect(await page.evaluate(() => Object.hasOwn(globalThis, "injected"))).toBe(
    false,
  );
  await expect(response.locator("img,iframe,script")).toHaveCount(0);
  await send(page, "error");
  await expect(response).toContainText("500 Internal Server Error");
  await send(page, "empty");
  await expect(response).toContainText("Empty response body");
  await send(page, "timeout");
  await expect(response.getByRole("heading")).toHaveText("Request timed out");
  await send(page, "large-history-failure");
  await expect(response).toContainText("Preview truncated");
  await expect(response).toContainText("response kept");
});
test("parallel tabs, cancel, resend and closing a running tab are isolated", async ({
  page,
}) => {
  await send(page, "slow");
  await request(page, "Second");
  await send(page, "json");
  await expect(page.getByTestId("response-pane")).toContainText("200 OK");
  await page.getByRole("tab", { name: /GET First/ }).click();
  await page
    .getByRole("button", { name: "Cancel request", exact: true })
    .click();
  await expect(page.getByTestId("response-pane")).toContainText(
    "Request cancelled",
  );
  await send(page, "json");
  await expect(page.getByTestId("response-pane")).toContainText("200 OK");
  await page.getByRole("button", { name: "Save request", exact: true }).click();
  await page
    .getByLabel("Request URL", { exact: true })
    .fill("http://fixture.test/slow");
  await page.getByRole("button", { name: "Save request", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Close First", exact: true }).click();
  await expect(page.getByRole("tab", { name: /GET First/ })).toHaveCount(0);
  await expect(page.getByTestId("response-pane")).toContainText("200 OK");
});
test("Quit Cancel keeps drafts; Save All then restores saved tabs after reload", async ({
  page,
}) => {
  await page.getByLabel("Request URL", { exact: true }).fill("/first");
  await request(page, "Second");
  await page.getByLabel("Request URL", { exact: true }).fill("/second");
  await page.keyboard.press("Control+q");
  const dialog = page.getByRole("dialog", { name: "Quit PostMen" });
  await expect(dialog).toContainText("First");
  await expect(dialog).toContainText("Second");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page
      .getByRole("tablist", { name: "Open requests" })
      .getByLabel("Unsaved changes"),
  ).toHaveCount(2);
  await page.keyboard.press("Control+q");
  await dialog
    .getByRole("button", { name: "Save All and Quit", exact: true })
    .click();
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "data-closed",
    "true",
  );
  await page.reload();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue(
    "/second",
  );
  await page.getByRole("tab", { name: "GET First", exact: true }).click();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue(
    "/first",
  );
});
test("Discard Quit cancels active request and does not save its draft", async ({
  page,
}) => {
  await send(page, "slow");
  await page.keyboard.press("Control+q");
  await expect(page.getByRole("dialog")).toContainText(
    "active request(s) will be cancelled",
  );
  await page
    .getByRole("button", { name: "Discard and Quit", exact: true })
    .click();
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "data-closed",
    "true",
  );
  await page.reload();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("");
});
