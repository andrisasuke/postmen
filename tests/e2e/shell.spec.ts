import { expect, test } from "@playwright/test";

test("clean launch has no demo data and no simulated native connection", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "data-connection",
    "browser",
  );
  await expect(page.getByText("No collections yet")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create Collection", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("PostMen Reference", { exact: true }),
  ).toHaveCount(0);
});

test("light/dark/system follows OS, persists explicit selection, and keyboard menu closes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Change theme" }).click();
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Change theme" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Change theme" }),
  ).toBeFocused();
});

test("reference shell resize, orientation, collapse, and persistence", async ({
  page,
}) => {
  await page.goto("/?fixture=reference");
  await expect(page.getByTestId("request-pane")).toBeVisible();
  const request = await page.getByTestId("request-pane").boundingBox();
  expect(request?.width).toBeCloseTo(540.91, 0);
  const sidebar = page.getByRole("separator", { name: "Resize sidebar" });
  await sidebar.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sidebar).toHaveAttribute("aria-valuenow", "260");
  const divider = page.getByRole("separator", {
    name: "Resize request and response",
  });
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("button", { name: "Toggle response layout", exact: true })
    .click();
  await expect(page.getByTestId("split-panes")).toHaveAttribute(
    "data-orientation",
    "vertical",
  );
  await page
    .getByRole("button", { name: "Collapse response pane", exact: true })
    .click();
  await expect(page.getByTestId("response-pane")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand response pane" }).click();
  await expect(page.getByTestId("response-pane")).toBeVisible();
  await page.reload();
  await expect(sidebar).toHaveAttribute("aria-valuenow", "260");
});

test("small window sidebar opens, selects requests, and dismisses", async ({
  page,
}) => {
  await page.goto("/?fixture=reference");
  await expect(page.getByTestId("request-pane")).toBeVisible();
  await page.setViewportSize({ width: 700, height: 400 });
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await expect(page.getByTestId("split-panes")).toHaveAttribute(
    "data-orientation",
    "vertical",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    700,
  );
  await page
    .getByRole("button", { name: "Toggle sidebar", exact: true })
    .click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "GET List users", exact: true })
    .click();
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "GET List users", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "Toggle sidebar", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Toggle sidebar", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close collection sidebar", exact: true })
    .click({ position: { x: 690, y: 20 } });
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await page
    .getByRole("button", { name: "About PostMen", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("fixture tree, context menu, destructive modal cancel, and tabs work without network writes", async ({
  page,
}) => {
  const network: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(":43119")) network.push(request.url());
  });
  await page.goto("/?fixture=reference");
  const item = page
    .getByTestId("sidebar")
    .getByRole("button", { name: "POST Create user", exact: true });
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete preview request" }).click();
  await expect(page.getByRole("dialog")).toContainText("Create user");
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(item).toBeVisible();
  await page
    .getByRole("button", { name: "Close Create user", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tab", { name: "POST Create user", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Exit UI preview", exact: true })
    .click();
  await expect(page.getByText("No collections yet")).toBeVisible();
  expect(network).toEqual([]);
});

test("pointer resize and edge collapse work, including scrolling the small layout", async ({
  page,
}) => {
  await page.goto("/?fixture=reference");
  const sidebar = page.getByRole("separator", { name: "Resize sidebar" });
  await expect(sidebar).toHaveAttribute("aria-valuenow", "250");
  const sidebarBox = await sidebar.boundingBox();
  if (!sidebarBox) throw new Error("Sidebar separator missing");
  await page.mouse.move(
    sidebarBox.x + sidebarBox.width / 2,
    sidebarBox.y + 100,
  );
  await page.mouse.down();
  await page.mouse.move(300, sidebarBox.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(sidebar).toHaveAttribute("aria-valuenow", "300");

  const divider = page.getByRole("separator", {
    name: "Resize request and response",
  });
  const dividerBox = await divider.boundingBox();
  const panesBox = await page.getByTestId("split-panes").boundingBox();
  if (!dividerBox || !panesBox) throw new Error("Split panes missing");
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(panesBox.x + 40, dividerBox.y + 60, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("request-pane")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand request pane" }).click();
  await expect(page.getByTestId("request-pane")).toBeVisible();

  await page.setViewportSize({ width: 700, height: 400 });
  await page.getByTestId("response-pane").scrollIntoViewIfNeeded();
  const visibleResponse = await page.getByTestId("response-pane").boundingBox();
  expect(visibleResponse?.height).toBeGreaterThanOrEqual(150);
  expect(
    (visibleResponse?.y ?? 0) + (visibleResponse?.height ?? 0),
  ).toBeLessThanOrEqual(376);
  expect(
    await page
      .getByTestId("split-panes")
      .evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
});
