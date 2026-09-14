import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import CreateFolderDialog from "./CreateFolderDialog.vue";

const store = vi.hoisted(() => ({ createFolder: vi.fn() }));
const notifications = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../stores/notifications", () => ({ useNotificationsStore: () => notifications }));
vi.mock("../stores/workspace", () => ({ useWorkspaceStore: () => store }));
const parent = { collectionId: "collection", parentId: "parent-folder" };
let wrapper: VueWrapper;
const input = () => document.querySelector<HTMLInputElement>("input")!;
async function submit() {
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flushPromises();
}
async function fill(value: string) {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await flushPromises();
}
beforeEach(async () => {
  notifications.error.mockReset();
  store.createFolder.mockReset().mockResolvedValue({ id: "new-folder" });
  wrapper = mount(CreateFolderDialog, { props: { parent }, attachTo: document.body });
  await flushPromises();
});
afterEach(() => {
  wrapper.unmount();
  document.body.replaceChildren();
});
describe("New Folder dialog", () => {
  it("focuses Folder Name, has no Options and saves under the chosen parent", async () => {
    expect(document.querySelector("h2")?.textContent).toBe("New Folder");
    expect(document.querySelector("label")?.textContent).toBe("Folder Name");
    expect(document.activeElement).toBe(input());
    expect(document.body.textContent).not.toContain("Options");
    await fill("  Child 日本語  ");
    await submit();
    expect(store.createFolder).toHaveBeenCalledWith(parent, "Child 日本語");
    expect(wrapper.emitted("created")).toHaveLength(1);
  });
  it("rejects blank names without writing or closing", async () => {
    await fill("   ");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Enter a folder name");
    expect(store.createFolder).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith("Failed to create folder. Check the name.");
    expect(wrapper.emitted("created")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
  });
  it("Cancel and Escape close without writing", async () => {
    await fill("Unsubmitted");
    const cancel = [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Cancel")!;
    cancel.click();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(2);
    expect(store.createFolder).not.toHaveBeenCalled();
  });
  it("keeps the name on failed save and allows retry", async () => {
    store.createFolder.mockRejectedValueOnce(new Error("Storage unavailable"));
    await fill("Retry folder");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Storage unavailable");
    expect(input().value).toBe("Retry folder");
    expect(wrapper.emitted("created")).toBeUndefined();
    await submit();
    expect(wrapper.emitted("created")).toHaveLength(1);
  });
  it("blocks duplicate submit and dismiss while save is pending", async () => {
    let finish!: () => void;
    store.createFolder.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await fill("Once");
    await submit();
    await submit();
    expect(input().disabled).toBe(true);
    expect([...document.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(store.createFolder).toHaveBeenCalledTimes(1);
    finish();
    await flushPromises();
    expect(wrapper.emitted("created")).toHaveLength(1);
  });
});
