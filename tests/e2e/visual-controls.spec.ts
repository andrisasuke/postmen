import { expect, test } from "@playwright/test";
import { menuAction, select } from "./controls";
test.beforeEach(async ({ page }) => {
  await page.goto("/?fixture=visual");
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "POST Create user", exact: true })
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
