import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import CloneRequestDialog from "./CloneRequestDialog.vue";

const store = vi.hoisted(() => ({ cloneRequest: vi.fn(), dirty: vi.fn() }));
const notifications = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../stores/notifications", () => ({ useNotificationsStore: () => notifications }));
vi.mock("../stores/workspace", () => ({ useWorkspaceStore: () => store }));
let wrapper: VueWrapper;
const input = () => document.querySelector<HTMLInputElement>("input")!;
async function fill(value: string) {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await flushPromises();
}
async function submit() {
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flushPromises();
}
beforeEach(async () => {
  notifications.error.mockReset();
  store.cloneRequest.mockReset().mockResolvedValue({ id: "copy" });
  store.dirty.mockReset().mockReturnValue(true);
  wrapper = mount(CloneRequestDialog, { props: { requestId: "source", requestName: "List users" }, attachTo: document.body });
  await flushPromises();
});
afterEach(() => { wrapper.unmount(); document.body.replaceChildren(); });
describe("Clone Request dialog", () => {
  it("prefills and selects the copy name, without creating until submit", async () => {
    expect(input().value).toBe("List users - Copy");
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(input().value.length);
    expect(store.cloneRequest).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Includes unsaved changes");
    await fill("  My copy  ");
    await submit();
    expect(store.cloneRequest).toHaveBeenCalledWith("source", "My copy");
    expect(wrapper.emitted("created")).toEqual([["copy"]]);
  });
  it("Cancel and Escape never clone", async () => {
    [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Cancel")!.click();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(2);
    expect(store.cloneRequest).not.toHaveBeenCalled();
  });
  it("validates the name and retains it when persistence fails", async () => {
    await fill(" ");
    await submit();
    expect(notifications.error).toHaveBeenCalledWith("Failed to clone request. Check the name.");
    expect(store.cloneRequest).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Enter a request name");
    await fill("Retry copy");
    store.cloneRequest.mockRejectedValueOnce(new Error("Disk full"));
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Disk full");
    expect(input().value).toBe("Retry copy");
    expect(wrapper.emitted("created")).toBeUndefined();
    await submit();
    expect(wrapper.emitted("created")).toEqual([["copy"]]);
  });
  it("disables dismiss and repeated submit until cloning finishes", async () => {
    let finish!: (value: { id: string }) => void;
    store.cloneRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await submit();
    await submit();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(store.cloneRequest).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
    finish({ id: "copy" });
    await flushPromises();
    expect(wrapper.emitted("created")).toEqual([["copy"]]);
  });
});
