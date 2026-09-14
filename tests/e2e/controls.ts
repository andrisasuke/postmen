import { expect, type Page } from "@playwright/test";
export async function select(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page
    .getByRole("listbox", { name: label, exact: true })
    .getByRole("option", { name: option, exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: label, exact: true }),
  ).toHaveText(option);
}
export async function menuAction(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("menuitem", { name: option, exact: true }).click();
}
