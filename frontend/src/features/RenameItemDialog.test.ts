import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import RenameItemDialog from "./RenameItemDialog.vue";

const store = vi.hoisted(() => ({ rename: vi.fn() }));
const notifications = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../stores/notifications", () => ({ useNotificationsStore: () => notifications }));
vi.mock("../stores/workspace", () => ({ useWorkspaceStore: () => store }));
let wrapper: VueWrapper;
const input = () => document.querySelector<HTMLInputElement>("input")!;
async function setup(kind: "request" | "folder" = "request") {
  wrapper = mount(RenameItemDialog, { props: { item: { kind, id: "source" }, initialName: "Original" }, attachTo: document.body });
  await flushPromises();
}
async function fill(value: string) {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await flushPromises();
}
async function submit() {
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flushPromises();
}
beforeEach(() => { store.rename.mockReset().mockResolvedValue(undefined); notifications.error.mockReset(); });
afterEach(() => { wrapper?.unmount(); document.body.replaceChildren(); });
describe("Rename Request / Folder dialog", () => {
  it.each(["request", "folder"] as const)("prefills and selects the existing %s name before saving", async kind => {
    await setup(kind);
    const title = kind === "request" ? "Request" : "Folder";
    expect(document.querySelector("h2")?.textContent).toBe(`Rename ${title}`);
    expect(document.querySelector("label")?.textContent).toBe(`${title} Name`);
    expect(input().value).toBe("Original");
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(8);
    expect(store.rename).not.toHaveBeenCalled();
    await fill("  Renamed 日本語  ");
    await submit();
    expect(store.rename).toHaveBeenCalledWith({ kind, id: "source" }, "Renamed 日本語");
    expect(wrapper.emitted("renamed")).toHaveLength(1);
  });
  it("Cancel and Escape do not save", async () => {
    await setup();
    await fill("Cancelled");
    [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Cancel")!.click();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(2);
    expect(store.rename).not.toHaveBeenCalled();
  });
  it("rejects blank names and keeps the form on save failure", async () => {
    await setup("folder");
    await fill(" ");
    await submit();
    expect(store.rename).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Enter a folder name");
    store.rename.mockRejectedValueOnce(new Error("Storage unavailable"));
    await fill("Retry");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Storage unavailable");
    expect(input().value).toBe("Retry");
    expect(wrapper.emitted("renamed")).toBeUndefined();
    await submit();
    expect(wrapper.emitted("renamed")).toHaveLength(1);
  });
  it("blocks repeated submit and dismiss while renaming", async () => {
    await setup();
    let finish!: () => void;
    store.rename.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await submit();
    await submit();
    expect(store.rename).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(wrapper.emitted("close")).toBeUndefined();
    finish();
    await flushPromises();
    expect(wrapper.emitted("renamed")).toHaveLength(1);
  });
});
