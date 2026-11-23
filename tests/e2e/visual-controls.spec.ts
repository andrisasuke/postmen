import { expect, test, type Locator } from "@playwright/test";
import { menuAction, select } from "./controls";

async function expectEditorLines(editor: Locator, lines: string[]) {
  await expect.poll(() => editor.locator(".cm-line").count()).toBe(lines.length);
  for (let index = 0; index < lines.length; index++)
    await expect
      .poll(() => editor.locator(".cm-line").nth(index).textContent())
      .toBe(lines[index]);
}
test.beforeEach(async ({ page }) => {
  await page.goto("/?fixture=visual");
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: /^HTTP POST method Create user/ })
    .click();
  await expect(page.getByTestId("json-editor-input")).toBeVisible();
});
test("select keyboard, Escape cancellation and outside click; timeout menu stays functional", async ({
  page,
}) => {
  const control = page.getByRole("combobox", {
    name: "Body type",
    exact: true,
  });
  await control.focus();
  await control.press("ArrowDown");
  await control.press("End");
  await control.press("Escape");
  await expect(control).toHaveText("JSON");
  await expect(control).toBeFocused();
  await control.press("ArrowDown");
  await control.press("End");
  await control.press("Enter");
  await expect(control).toHaveText("Multipart Form");
  await control.click();
  await page.getByLabel("Request URL", { exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Request timeout", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "5 s timeout", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Request timeout", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: "5 s timeout", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});
test("fold/unfold and bounded Prettify preserve editable request; response stays read-only", async ({
  page,
}) => {
  const editor = page.getByTestId("json-editor-input");
  await menuAction(page, "JSON editor actions", "Fold JSON");
  await expect(editor.locator(".cm-foldPlaceholder")).toBeVisible();
  await menuAction(page, "JSON editor actions", "Unfold JSON");
  await expect(editor).toContainText("Alex Morgan");
  const body = "[".repeat(65) + "0" + "]".repeat(65);
  await editor.fill(body);
  await page.getByRole("button", { name: "Format JSON", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Formatting safety limit",
  );
  await expect(editor).toHaveText(body);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = page.getByTestId("response-body-text");
  await expect(response).toContainText("Alex Morgan");
  await expect(response).toHaveAttribute("contenteditable", "false");
  await menuAction(page, "Response actions", "Fold response");
  await expect(response.locator(".cm-foldPlaceholder")).toBeVisible();
  await menuAction(page, "Response actions", "Unfold response");
  await expect(response).toContainText("Alex Morgan");
});
test("block comments format, undo, save and reopen without hiding string markers", async ({
  page,
}) => {
  const editor = page.getByTestId("json-editor-input");
  const draft = `{"a":/* first */1,
"b":"test/* */",/* second */"n":3}`;
  const brokenDraft = `{"a":/* first */1
"b":"test/* */",/* second */"n":3}`;
  const lintMarkers = editor.locator(
    ".cm-lintRange-error, .cm-lintPoint-error",
  );
  await editor.fill(brokenDraft);
  await expect(lintMarkers.first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  await page.keyboard.insertText(",");
  await expect(lintMarkers).toHaveCount(0);
  await expectEditorLines(editor, draft.split("\n"));
  await expect(editor.locator(".cm-comment").first()).toBeVisible();
  await expect
    .poll(async () => (await editor.locator(".cm-comment").allTextContents()).join(""))
    .toContain("/* first */");
  expect((await editor.locator(".cm-comment").allTextContents()).join("")).toContain(
    "/* second */",
  );
  expect((await editor.locator(".cm-comment").allTextContents()).join("")).not.toContain(
    "test/* */",
  );

  const setTheme = async (theme: string) => {
    await page
      .getByRole("button", { name: "Change theme", exact: true })
      .click();
    await page.getByRole("menuitemradio", { name: theme, exact: true }).click();
    await expect(editor.locator(".cm-comment").first()).toBeVisible();
  };
  const commentColor = () =>
    editor
      .locator(".cm-comment")
      .first()
      .evaluate((element) => getComputedStyle(element).color);
  await setTheme("Light");
  const light = await commentColor();
  await setTheme("Dark");
  const dark = await commentColor();
  expect(dark).not.toBe(light);
  const gray = (color: string) => {
    const channels = (color.match(/\d+/g) ?? []).map(Number);
    return (
      channels.length >= 3 &&
      channels[0] === channels[1] &&
      channels[1] === channels[2]
    );
  };
  expect(gray(light)).toBe(true);
  expect(gray(dark)).toBe(true);
  await setTheme("Light");
  expect(await commentColor()).toBe(light);

  await page.getByRole("button", { name: "Format JSON", exact: true }).click();
  await expect
    .poll(async () => (await editor.locator(".cm-line").allTextContents()).join("\n"))
    .not.toBe(draft);
  const formatted = (await editor.locator(".cm-line").allTextContents()).join("\n");
  expect(formatted.split("\n").length).toBeGreaterThan(draft.split("\n").length);
  expect(formatted).toContain('"a": /* first */ 1');
  expect(formatted).toContain('"b": "test/* */"');
  expect(formatted.indexOf("/* first */")).toBeLessThan(
    formatted.indexOf("/* second */"),
  );
  await expect(editor.locator(".cm-comment").first()).toBeVisible();
  const formattedComments = (
    await editor.locator(".cm-comment").allTextContents()
  ).join("");
  expect(formattedComments).toContain("/* first */");
  expect(formattedComments).toContain("/* second */");
  expect(formattedComments).not.toContain("test/* */");
  await expect(editor.locator(".cm-lintRange-error")).toHaveCount(0);

  await menuAction(page, "JSON editor actions", "Undo JSON edit");
  await expectEditorLines(editor, draft.split("\n"));
  await page.getByRole("button", { name: "Save request", exact: true }).click();
  await expect(
    page
      .getByRole("tablist", { name: "Open requests" })
      .getByLabel("Unsaved changes"),
  ).toHaveCount(0);
  await page.keyboard.press("Control+w");
  await expect(
    page.getByRole("tab", { name: "POST Create user", exact: true }),
  ).toHaveCount(0);
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: /^HTTP POST method Create user/ })
    .click();
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await expectEditorLines(editor, draft.split("\n"));
  await expect(editor.locator(".cm-comment").first()).toBeVisible();
  const reopenedComments = (
    await editor.locator(".cm-comment").allTextContents()
  ).join("");
  expect(reopenedComments).toContain("/* first */");
  expect(reopenedComments).toContain("/* second */");
  expect(reopenedComments).not.toContain("test/* */");
  await expect(editor).toContainText('"test/* */"');
});
test("minimum window lets users reach response, menus and file fields", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 400 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("response-body-text")).toContainText(
    "Alex Morgan",
  );
  await select(page, "Response format", "Raw");
  await menuAction(page, "Response actions", "Search response");
  await expect(
    page
      .getByTestId("response-pane")
      .locator('.cm-search input[name="search"]'),
  ).toBeVisible();
  await page
    .getByTestId("response-pane")
    .locator('.cm-search input[name="search"]')
    .press("Escape");
  await select(page, "Body type", "Multipart Form");
  await page
    .getByRole("button", { name: "Add multipart field", exact: true })
    .click();
  await select(page, "Multipart type 1", "File");
  await page.getByRole("button", { name: "Choose file", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("native Tauri");
});
test("invalid JSON marks the original line and shows a safe parse-error detail", async ({
  page,
}) => {
  const editor = page.getByTestId("json-editor-input");
  const marker = page
    .getByTestId("json-editor")
    .locator(".cm-lineNumbers .cm-gutterElement.cm-json-error-gutter");
  const tooltip = page.getByTestId("json-error-tooltip");
  const invalid = '{\n  "name": "Alex Morgan",\n  "bad": kk\n}';
  await editor.fill(invalid);
  await expect(marker).toHaveText("3");
  await expect(marker).toHaveAttribute("tabindex", "0");

  await marker.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(/Parse error on line 3, column \d+/);
  await expect(tooltip).toContainText('"bad": kk');
  await expect(tooltip).toContainText("^");
  await expect(tooltip).toContainText(/JSON|token|unexpected/i);
  await editor.click({ position: { x: 4, y: 4 } });
  await expect(tooltip).toHaveCount(0);

  await marker.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tooltip).toHaveCount(0);

  await marker.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);

  await editor.fill('{\n/* note\n   spanning */\n"a": 1,\n"b": kk\n}');
  await expect(marker).toHaveText("5");
  await marker.hover();
  await expect(tooltip).toContainText('"b": kk');

  const long = `{"text":"${"x".repeat(400)}",\n  "bad": kk\n}`;
  await editor.fill(long);
  await expect(marker).toHaveText("2");

  await editor.fill('{\n  "a": [1, 2\n}');
  await expect(marker).toHaveText("3");
  await marker.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(
    /Parse error on line 3, column \d+/,
  );

  await editor.fill('{\n  "a": 1\n}');
  await expect(marker).toHaveCount(0);
  await expect(tooltip).toHaveCount(0);
});

test("Prettify on invalid JSON shows the marker without changing body or history", async ({
  page,
}) => {
  const editor = page.getByTestId("json-editor-input");
  const marker = page
    .getByTestId("json-editor")
    .locator(".cm-lineNumbers .cm-gutterElement.cm-json-error-gutter");
  const tooltip = page.getByTestId("json-error-tooltip");
  const invalid = '{\n  "a": 1,\n  "bad": kk\n}';
  await editor.fill(invalid);
  const before = await editor.locator(".cm-line").allTextContents();
  await page.getByRole("button", { name: "Format JSON", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Invalid JSON");
  await expect(marker).toHaveText("3", { timeout: 400 });
  expect(await editor.locator(".cm-line").allTextContents()).toEqual(before);
  await marker.hover();
  await expect(tooltip).toContainText(/Parse error on line 3, column \d+/);
  await expect(tooltip).toContainText('"bad": kk');

  await page
    .getByRole("button", { name: "Change theme", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await expect(marker).toHaveText("3");
  await marker.hover();
  await expect(tooltip).toBeVisible();

  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: /^HTTP GET method List users/ })
    .click();
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: /^HTTP POST method Create user/ })
    .click();
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await expect(marker).toHaveText("3");

  await menuAction(page, "JSON editor actions", "Undo JSON edit");
  await expect(editor).toContainText('"name": "Alex Morgan"');
  await expect(marker).toHaveCount(0);
});
