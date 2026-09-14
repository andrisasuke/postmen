import { expect, test, type Page } from "@playwright/test";
import { select, menuAction } from "./controls";

async function createCollection(page: Page, name = "Workspace 日本語") {
  await page
    .getByRole("button", { name: "Create collection", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Item name" }).fill(name);
  await page
    .getByRole("button", { name: "Confirm create collection", exact: true })
    .click();
  await expect(
    page.getByTestId("sidebar").getByRole("button", { name, exact: true }),
  ).toBeVisible();
}
async function context(page: Page, name: string, action: string) {
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name, exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}
async function newRequest(
  page: Page,
  name: string,
  parent = "Workspace 日本語",
) {
  await context(page, parent, "New request");
  const dialog = page.getByRole("dialog", { name: "New Request" });
  await dialog.getByRole("textbox", { name: "Request Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: `GET ${name}`, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save request", exact: true }).click();
  await expect(
    page
      .getByRole("tablist", { name: "Open requests" })
      .getByLabel("Unsaved changes"),
  ).toHaveCount(0);
}
async function json(page: Page, value: string) {
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await select(page, "Body type", "JSON");
  await page.getByTestId("json-editor-input").fill(value);
}
test.beforeEach(async ({ page }) => {
  await page.goto("/?fixture=workspace");
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(
    page.getByText("Browser fixture · no SQLite", { exact: true }),
  ).toBeVisible();
});

test("CRUD, repeated headers and params persist across browser fixture reload", async ({
  page,
}) => {
  await createCollection(page);
  await newRequest(page, "List users");
  await page
    .getByLabel("Request URL", { exact: true })
    .fill("/users?existing=1");
  await page
    .getByRole("button", { name: "Add parameter", exact: true })
    .click();
  await page
    .getByLabel("Query parameters name 1", { exact: true })
    .fill("q");
  await page
    .getByLabel("Query parameters value 1", { exact: true })
    .fill("日本語");
  await page
    .getByRole("tablist", { name: "Request sections" })
    .getByRole("tab", { name: "Headers", exact: true })
    .click();
  for (let i = 1; i <= 2; i++) {
    await page.getByRole("button", { name: "Add header", exact: true }).click();
    await page
      .getByLabel(`Request headers name ${i}`, { exact: true })
      .fill("X-Repeat");
    await page
      .getByLabel(`Request headers value ${i}`, { exact: true })
      .fill(`value ${i}`);
  }
  await page
    .getByRole("checkbox", {
      name: "Enable Request headers row 2",
      exact: true,
    })
    .uncheck();
  await save(page);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(
    page.getByLabel("Request URL", { exact: true }),
  ).toHaveValue("/users?existing=1");
  await expect(
    page.getByLabel("Request headers value 2", { exact: true }),
  ).toHaveValue("value 2");
  await expect(
    page.getByRole("checkbox", {
      name: "Enable Request headers row 2",
      exact: true,
    }),
  ).not.toBeChecked();
  await page.getByRole("tab", { name: /^Params/ }).click();
  await expect(
    page.getByRole("textbox", {
      name: "Query parameters value 1",
      exact: true,
    }),
  ).toHaveValue("日本語");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
});

test("independent dirty drafts and Save/Discard/Cancel close workflow", async ({
  page,
}) => {
  await createCollection(page);
  await newRequest(page, "Alpha");
  await page
    .getByLabel("Request URL", { exact: true })
    .fill("/alpha-draft");
  await newRequest(page, "Beta");
  await page
    .getByLabel("Request URL", { exact: true })
    .fill("/beta-draft");
  await page.getByRole("tab", { name: /GET Alpha/ }).click();
  await expect(
    page.getByLabel("Request URL", { exact: true }),
  ).toHaveValue("/alpha-draft");
  const alphaTab = page.getByRole("tab", { name: /GET Alpha/ });
  const closeAlpha = page.getByRole("button", { name: "Close Alpha", exact: true });
  await expect(closeAlpha).toBeHidden();
  await alphaTab.hover();
  await expect(closeAlpha).toBeVisible();
  await closeAlpha.click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "Unsaved Changes",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("tab", { name: /GET Alpha/ })).toBeVisible();
  await alphaTab.hover();
  await closeAlpha.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: /GET Alpha/ })).toHaveCount(0);
  await expect(
    page.getByLabel("Request URL", { exact: true }),
  ).toHaveValue("/beta-draft");
  const betaTab = page.getByRole("tab", { name: /GET Beta/ });
  const closeBeta = page.getByRole("button", { name: "Close Beta", exact: true });
  await expect(closeBeta).toBeHidden();
  await betaTab.hover();
  await expect(closeBeta).toBeVisible();
  await closeBeta.click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "GET Alpha", exact: true })
    .click();
  await expect(
    page.getByLabel("Request URL", { exact: true }),
  ).toHaveValue("/alpha-draft");
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "GET Beta", exact: true })
    .click();
  await expect(
    page.getByLabel("Request URL", { exact: true }),
  ).toHaveValue("");
});

test("CodeMirror format, validation and undo survive tab switching", async ({
  page,
}) => {
  await createCollection(page);
  await newRequest(page, "JSON body");
  await json(page, '{"name":"日本語","count":1}');
  await page.getByRole("button", { name: "Format JSON", exact: true }).click();
  await expect(page.getByTestId("json-editor-input")).toContainText(
    '"count": 1',
  );
  await newRequest(page, "Second");
  await page.getByRole("tab", { name: /GET JSON body/ }).click();
  await menuAction(page, "JSON editor actions", "Undo JSON edit");
  await expect(page.getByTestId("json-editor-input")).toHaveText(
    '{"name":"日本語","count":1}',
  );
  await menuAction(page, "JSON editor actions", "Redo JSON edit");
  await expect(page.getByTestId("json-editor-input")).toContainText(
    '"count": 1',
  );
  await page.getByTestId("json-editor-input").fill("{invalid");
  await page.getByRole("button", { name: "Format JSON", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Invalid JSON" }),
  ).toBeVisible();
  await save(page);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByTestId("json-editor-input")).toHaveText("{invalid");
});

test("tree rename, nested folders, move, reorder, search and cascade confirmation", async ({
  page,
}) => {
  await createCollection(page);
  await context(page, "Workspace 日本語", "New folder");
  const folderDialog = page.getByRole("dialog", { name: "New Folder", exact: true });
  await folderDialog.getByRole("textbox", { name: "Folder Name", exact: true }).fill("Folder");
  await folderDialog.getByRole("button", { name: "Create", exact: true }).click();
  await newRequest(page, "Alpha");
  await newRequest(page, "Beta");
  await context(page, "GET Alpha", "Rename");
  const renameDialog = page.getByRole("dialog", { name: "Rename Request", exact: true });
  await expect(renameDialog.getByLabel("Request Name", { exact: true })).toHaveValue("Alpha");
  await renameDialog.getByLabel("Request Name", { exact: true }).fill("Renamed");
  await renameDialog.getByRole("button", { name: "Rename", exact: true }).click();
  await context(page, "GET Renamed", "Move to folder");
  await select(page, "Destination folder", "Folder");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await context(page, "GET Beta", "Move up");
  const labels = await page.locator(".data-tree-row").allTextContents();
  expect(labels.map((x) => x.trim().replace(/\s+/g, " "))).toEqual([
    "Workspace 日本語",
    "GETBeta",
    "Folder",
    "GETRenamed",
  ]);
  await page
    .getByRole("button", { name: "Search collections", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search collections", exact: true })
    .fill("renamed");
  await expect(
    page
      .getByTestId("sidebar")
      .getByRole("button", { name: "GET Beta", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByTestId("sidebar")
      .getByRole("button", { name: "Folder", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search collections", exact: true })
    .fill("");
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "GET Renamed", exact: true })
    .click();
  await page
    .getByLabel("Request URL", { exact: true })
    .fill("/dirty");
  await context(page, "Folder", "Delete folder");
  await expect(page.getByRole("dialog")).toContainText("Unsaved drafts");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await context(page, "Folder", "Delete folder");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: /GET Renamed/ })).toHaveCount(0);
  await expect(
    page
      .getByTestId("sidebar")
      .getByRole("button", { name: "GET Beta", exact: true }),
  ).toBeVisible();
});

test("folder rename uses a prefilled dialog with cancel and Enter submit", async ({ page }) => {
  await createCollection(page);
  await context(page, "Workspace 日本語", "New folder");
  const create = page.getByRole("dialog", { name: "New Folder", exact: true });
  await create.getByLabel("Folder Name", { exact: true }).fill("Original folder");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await context(page, "Original folder", "Rename");
  const dialog = page.getByRole("dialog", { name: "Rename Folder", exact: true });
  const name = dialog.getByLabel("Folder Name", { exact: true });
  await expect(name).toHaveValue("Original folder");
  await expect(name).toBeFocused();
  await name.fill("Cancelled");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await context(page, "Original folder", "Rename");
  await expect(name).toHaveValue("Original folder");
  await name.fill("Renamed folder");
  await name.press("Enter");
  await expect(dialog).toHaveCount(0);
  const tree = page.getByTestId("sidebar");
  await expect(tree.getByRole("button", { name: "Renamed folder", exact: true })).toBeVisible();
  await expect(tree.getByRole("button", { name: "Original folder", exact: true })).toHaveCount(0);
});

test("cURL URL query appears in Params and persists without a duplicated URL query", async ({ page }) => {
  await createCollection(page);
  await context(page, "Workspace 日本語", "New request");
  const dialog = page.getByRole("dialog", { name: "New Request", exact: true });
  await dialog.getByRole("radio", { name: "From cURL", exact: true }).check();
  await dialog.getByLabel("Request Name", { exact: true }).fill("Get Weather");
  await dialog.getByLabel("cURL Command", { exact: true }).fill("curl 'http://wttr.in?format=j1&lang=id&lang=en'");
  await expect(dialog).toContainText("3 params");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("http://wttr.in");
  await expect(page.getByLabel("Query parameters name 1", { exact: true })).toHaveValue("format");
  await expect(page.getByLabel("Query parameters value 1", { exact: true })).toHaveValue("j1");
  await expect(page.getByLabel("Query parameters name 2", { exact: true })).toHaveValue("lang");
  await expect(page.getByLabel("Query parameters value 3", { exact: true })).toHaveValue("en");
  await page.getByLabel("Query parameters value 1", { exact: true }).fill("j2");
  await save(page);
  await page.reload();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("http://wttr.in");
  await expect(page.getByLabel("Query parameters value 1", { exact: true })).toHaveValue("j2");
});

test("request hover actions clone with a name and confirm deletion", async ({ page }) => {
  await createCollection(page);
  await newRequest(page, "Source");
  await page.getByLabel("Request URL", { exact: true }).fill("<<api_url>>/users");
  await save(page);
  await newRequest(page, "Other");
  const tree = page.getByTestId("sidebar");
  const source = tree.getByRole("button", { name: "GET Source", exact: true });
  const actions = tree.getByRole("button", { name: "Actions for Source", exact: true });
  await expect(actions).toHaveCSS("opacity", "0");
  await source.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await page.getByRole("tab", { name: "GET Other", exact: true }).hover();
  await expect(actions).toHaveCSS("opacity", "0");
  await source.hover();
  await actions.click();
  await expect(page.getByRole("tab", { name: "GET Other", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("menuitem", { name: "Clone", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Clone Request", exact: true });
  const name = dialog.getByRole("textbox", { name: "Request Name", exact: true });
  await expect(name).toHaveValue("Source - Copy");
  await expect(name).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(tree.getByRole("button", { name: "GET Source - Copy", exact: true })).toHaveCount(0);
  await source.hover();
  await actions.click();
  await page.getByRole("menuitem", { name: "Clone", exact: true }).click();
  await name.fill("Renamed copy");
  await dialog.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const copy = tree.getByRole("button", { name: "GET Renamed copy", exact: true });
  await expect(copy).toBeVisible();
  await expect(page.getByRole("tab", { name: "GET Renamed copy", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("<<api_url>>/users");
  const deleteDialog = page.getByRole("dialog", { name: "Delete request", exact: true });
  for (const confirm of [false, true]) {
    await copy.hover();
    await tree.getByRole("button", { name: "Actions for Renamed copy", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete request", exact: true }).click();
    await expect(deleteDialog).toContainText("Renamed copy");
    await expect(copy).toBeAttached();
    await deleteDialog.getByRole("button", { name: confirm ? "Delete" : "Cancel", exact: true }).click();
    await expect(deleteDialog).toHaveCount(0);
    await expect(copy).toHaveCount(confirm ? 0 : 1);
  }
  await expect(source).toBeVisible();
});

test("New Folder dialog creates nested folders and cancels without creating", async ({ page }) => {
  await createCollection(page);
  await context(page, "Workspace 日本語", "New folder");
  const dialog = page.getByRole("dialog", { name: "New Folder", exact: true });
  const name = dialog.getByRole("textbox", { name: "Folder Name", exact: true });
  await expect(name).toBeFocused();
  await expect(dialog.getByText("Options", { exact: true })).toHaveCount(0);
  await name.fill("Parent");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await context(page, "Parent", "New folder");
  await name.fill("Child");
  await name.press("Enter");
  await expect(dialog).toHaveCount(0);
  const tree = page.getByTestId("sidebar");
  await expect(tree.getByRole("button", { name: "Child", exact: true })).toBeVisible();
  await tree.getByRole("button", { name: "Parent", exact: true }).click();
  await expect(tree.getByRole("button", { name: "Child", exact: true })).toHaveCount(0);
  await context(page, "Parent", "New folder");
  await name.fill("Cancelled");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tree.getByRole("button", { name: "Cancelled", exact: true })).toHaveCount(0);
});

test("environment selection, autocomplete and deletion keep request templates", async ({
  page,
}) => {
  await createCollection(page);
  await newRequest(page, "Local request");
  await page.getByRole("button", { name: "Select environment", exact: true }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Environments", exact: true });
  await manager.getByRole("button", { name: "Create environment", exact: true }).first().click();
  await manager.getByLabel("Environment name", { exact: true }).fill("Local");
  await manager.getByLabel("Variable name 1", { exact: true }).fill("api_url");
  await manager.getByLabel("Variable value 1", { exact: true }).fill("http://localhost:3000/api");
  await manager.getByRole("button", { name: "Save", exact: true }).click();
  await manager.getByRole("button", { name: "Use environment", exact: true }).click();
  await manager.getByRole("button", { name: "Close dialog", exact: true }).click();
  const url = page.getByLabel("Request URL", { exact: true });
  await url.fill("<<api");
  await page.getByRole("option").filter({ hasText: "api_url" }).click();
  await expect(url).toHaveValue("<<api_url>>");
  await url.fill("<<api_url>>/users");
  await save(page);
  await page.getByRole("button", { name: "Select environment", exact: true }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await manager.getByRole("button", { name: "Delete environment", exact: true }).click();
  await manager.getByRole("button", { name: "Delete", exact: true }).click();
  await manager.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select environment", exact: true })).toHaveText("No Environment");
  await expect(url).toHaveValue("<<api_url>>/users");
});

test("multipart text persists and browser fixture reports native-only file picker", async ({
  page,
}) => {
  await createCollection(page);
  await newRequest(page, "Upload");
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await select(page, "Body type", "Multipart Form");
  await page
    .getByRole("button", { name: "Add multipart field", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Multipart name 1", exact: true })
    .fill("description");
  await page
    .getByRole("textbox", { name: "Multipart value 1", exact: true })
    .fill("日本語");
  await page
    .getByRole("button", { name: "Add multipart field", exact: true })
    .click();
  await select(page, "Multipart type 2", "File");
  await page.getByRole("button", { name: "Choose file", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("native Tauri");
  await page
    .getByRole("button", { name: "Remove multipart field 2", exact: true })
    .click();
  await save(page);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Multipart value 1", exact: true }),
  ).toHaveValue("日本語");
});

test("small window and saved JSON render in both themes without uncaught errors", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await createCollection(page);
  await newRequest(page, "Create user");
  await page.getByRole("button", { name: "HTTP method", exact: true }).click();
  await page.getByRole("menuitem", { name: "POST", exact: true }).click();
  await page
    .getByLabel("Request URL", { exact: true })
    .fill("/users");
  await json(
    page,
    '{"name":"Alex Morgan","email":"alex@example.test","active":true}',
  );
  await page.getByRole("button", { name: "Format JSON", exact: true }).click();
  await save(page);
  for (const theme of ["Light", "Dark"]) {
    await page
      .getByRole("button", { name: "Change theme", exact: true })
      .click();
    await page.getByRole("menuitemradio", { name: theme, exact: true }).click();
    await page.screenshot({
      path: `docs/milestones/M4/regression-${testInfo.project.name}-${theme.toLowerCase()}.png`,
    });
  }
  await page.setViewportSize({ width: 700, height: 400 });
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    700,
  );
  await expect(page.getByTestId("split-panes")).toHaveAttribute(
    "data-orientation",
    "vertical",
  );
  await page.getByTestId("response-pane").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `docs/milestones/M4/regression-${testInfo.project.name}-small.png`,
  });
  expect(errors).toEqual([]);
});

test("save/next/close shortcuts, tab reorder and per-tab pane state restore", async ({
  page,
}) => {
  await createCollection(page);
  await newRequest(page, "Alpha");
  await page
    .getByLabel("Request URL", { exact: true })
    .fill("/alpha");
  await page.keyboard.press("Control+s");
  await expect(
    page
      .getByRole("tablist", { name: "Open requests" })
      .getByLabel("Unsaved changes"),
  ).toHaveCount(0);
  const divider = page.getByRole("separator", {
    name: "Resize request and response",
  });
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  const alphaWidth = await page
    .getByTestId("request-pane")
    .evaluate((e) => e.getBoundingClientRect().width);
  await newRequest(page, "Beta");
  await page.keyboard.press("Control+Tab");
  await expect(
    page.getByRole("tab", { name: "GET Alpha", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page
      .getByTestId("request-pane")
      .evaluate((e) => e.getBoundingClientRect().width),
  ).toBeCloseTo(alphaWidth, 0);
  await page
    .getByRole("tab", { name: "GET Alpha", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Move tab right", exact: true })
    .click();
  await expect(
    page.getByRole("tablist", { name: "Open requests" }).getByRole("tab"),
  ).toHaveText(["GETBeta", "GETAlpha"]);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "GET Alpha", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page
      .getByTestId("request-pane")
      .evaluate((e) => e.getBoundingClientRect().width),
  ).toBeCloseTo(alphaWidth, 0);
  await page.keyboard.press("Control+w");
  await expect(
    page.getByRole("tab", { name: "GET Alpha", exact: true }),
  ).toHaveCount(0);
});

test("JSON search, cursor and scroll are retained between open tabs", async ({
  page,
}) => {
  await createCollection(page);
  await newRequest(page, "Long body");
  await json(
    page,
    JSON.stringify(
      Array.from({ length: 150 }, (_, index) => ({
        index,
        label: `row ${index}`,
      })),
      null,
      2,
    ),
  );
  const editor = page.getByTestId("json-editor-input");
  await editor.press("Control+End");
  await editor.press("ArrowLeft");
  const before = await page
    .locator(".cm-scroller")
    .evaluate((e) => e.scrollTop);
  expect(before).toBeGreaterThan(0);
  await newRequest(page, "Other");
  await page.getByRole("tab", { name: /GET Long body/ }).click();
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  await menuAction(page, "JSON editor actions", "Search JSON");
  await expect(page.locator(".cm-search input[name=search]")).toBeVisible();
  await page.locator(".cm-search input[name=search]").fill("row 140");
  await page.locator(".cm-search input[name=search]").press("Enter");
  await expect(page.locator(".cm-searchMatch").first()).toBeVisible();
});
