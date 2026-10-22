import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import { createMemoryApi } from "../fixtures/memory-api";
import type { RequestDoc } from "../types/data";
import GenerateCodeDialog from "./GenerateCodeDialog.vue";

const api = vi.hoisted(() => ({ generate: vi.fn(), select: vi.fn() }));
vi.mock("../services/generate-code", () => ({ generateCurl: api.generate }));
const ShellPreview = defineComponent({
  props: ["code"],
  setup(_, { expose }) { expose({ selectAll: api.select }); },
  template: '<pre aria-label="Generated cURL code">{{ code }}</pre>',
});
let wrapper: VueWrapper | undefined;
let request: RequestDoc;
let opener: HTMLButtonElement;
const code = "curl --globoff \\\n  --data-raw '  raw\nbody  '";
const copy = () => document.querySelector<HTMLButtonElement>('[aria-label="Copy cURL"]')!;
const icon = () => copy().querySelector('svg')!;
const fakeCopyTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
function pointer(target: Element, type: string) {
  const event = new MouseEvent(type, { bubbles: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}
function clickBackdrop() {
  const backdrop = document.querySelector('.modal-backdrop')!;
  pointer(backdrop, "pointerdown"); pointer(backdrop, "pointerup");
  backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}
async function render() {
  wrapper = mount(GenerateCodeDialog, { props: { request }, attachTo: document.body, global: { stubs: { ShellPreview } } });
  await flushPromises();
  // Drain jsdom's focus/selection events before counting clipboard timers.
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
}
beforeEach(async () => {
  vi.clearAllMocks(); api.generate.mockReset().mockResolvedValue({ code });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  const memory = createMemoryApi(); const c = await memory.createCollection("Synthetic");
  request = await memory.createRequest({ collectionId: c.id, folderId: null, name: "Synthetic" });
  opener = document.createElement("button"); document.body.append(opener); opener.focus();
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers(); document.body.replaceChildren(); });
it("shows loading with Copy disabled, then renders generated code", async () => {
  let finish!: (value: { code: string }) => void;
  api.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  expect(document.body.textContent).toContain("Generating cURL…"); expect(copy().disabled).toBe(true);
  expect(document.querySelector("h2")?.textContent).toBe("Generate Code");
  finish({ code }); await flushPromises();
  expect(copy().disabled).toBe(false); expect(document.querySelector("pre")?.textContent).toBe(code);
});
it("copies exact source without line numbers, showing only a green check for two seconds", async () => {
  fakeCopyTimers();
  let finish!: () => void;
  vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  expect(icon().classList.contains('tabler-icon-copy')).toBe(true);
  copy().click(); await flushPromises();
  expect(copy().disabled).toBe(true);
  expect(icon().classList.contains('tabler-icon-copy')).toBe(true);
  expect(copy().classList.contains('generate-code-copied')).toBe(false);
  // Also ignore programmatically dispatched clicks while a write is pending.
  copy().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  finish(); await flushPromises();
  expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(code);
  expect(copy().disabled).toBe(false);
  expect(icon().classList.contains('tabler-icon-check')).toBe(true);
  expect(copy().classList.contains('generate-code-copied')).toBe(true);
  expect(document.querySelector('.sr-only[role="status"]')?.textContent).toBe("Copied");
  expect(document.querySelector('.editor-message')).toBeNull();
  expect([...document.querySelectorAll('p')].some(p => p.textContent?.includes('Copied'))).toBe(false);
  await vi.advanceTimersByTimeAsync(1999);
  expect(icon().classList.contains('tabler-icon-check')).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(icon().classList.contains('tabler-icon-copy')).toBe(true);
  expect(copy().classList.contains('generate-code-copied')).toBe(false);
  expect(document.querySelector('.sr-only[role="status"]')?.textContent).toBe("");
  expect(wrapper!.emitted("close")).toBeUndefined();
});
it("restarts a single success timer on repeated copies", async () => {
  fakeCopyTimers();
  await render(); copy().click(); await flushPromises();
  await vi.advanceTimersByTimeAsync(1000);
  copy().click(); await flushPromises();
  expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(icon().classList.contains('tabler-icon-check')).toBe(true);
  await vi.advanceTimersByTimeAsync(999);
  expect(icon().classList.contains('tabler-icon-check')).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(icon().classList.contains('tabler-icon-copy')).toBe(true);
});
it("clears a previous success on failure and recovers on the next successful copy", async () => {
  fakeCopyTimers();
  await render(); copy().click(); await flushPromises();
  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("Denied"));
  copy().click(); await flushPromises();
  expect(icon().classList.contains('tabler-icon-copy')).toBe(true);
  expect(copy().classList.contains('generate-code-copied')).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(api.select).toHaveBeenCalledOnce();
  expect(document.querySelector('.editor-message')?.textContent).toContain("Cmd/Ctrl+C");
  copy().click(); await flushPromises();
  expect(icon().classList.contains('tabler-icon-check')).toBe(true);
  expect(document.querySelector('.editor-message')).toBeNull();
});
it.each(["close", "unmount"])("clears the success timer on %s", async kind => {
  fakeCopyTimers();
  await render(); copy().click(); await flushPromises();
  expect(vi.getTimerCount()).toBe(1);
  if (kind === "close") {
    document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click();
    await flushPromises();
    expect(icon().classList.contains('tabler-icon-copy')).toBe(true);
  } else { wrapper!.unmount(); wrapper = undefined; }
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  { kind: "success", removal: "close" }, { kind: "error", removal: "close" },
  { kind: "success", removal: "unmount" }, { kind: "error", removal: "unmount" },
])("ignores late clipboard $kind after $removal", async ({ kind, removal }) => {
  fakeCopyTimers();
  let finish!: () => void; let fail!: (error: Error) => void;
  vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  await render(); copy().click(); await flushPromises();
  if (removal === "close") document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click();
  else { wrapper!.unmount(); wrapper = undefined; }
  if (kind === "success") finish(); else fail(new Error("Late denial"));
  await flushPromises();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(document.querySelector('.generate-code-copied')).toBeNull();
  expect(document.querySelector('.editor-message')).toBeNull();
  expect(api.select).not.toHaveBeenCalled();
});
it("focuses the panel on opening and after code arrives, leaving X unfocused", async () => {
  let finish!: (value: { code: string }) => void;
  api.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  const panel = document.querySelector('[role="dialog"]')!;
  expect(panel.classList.contains("generate-code-dialog")).toBe(true);
  const x = document.querySelector('[aria-label="Close dialog"]')!;
  expect(document.activeElement).toBe(panel);
  expect(document.activeElement).not.toBe(x);
  finish({ code }); await flushPromises();
  expect(document.activeElement).toBe(panel);
  panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(x);
});
it("keeps Copy inside the code wrapper with no label toolbar or footer", async () => {
  await render();
  const area = document.querySelector('.generate-code-preview')!;
  expect(area.contains(copy())).toBe(true);
  expect(area.contains(document.querySelector('pre'))).toBe(true);
  expect(document.querySelector('.generate-code-toolbar')).toBeNull();
  expect(document.querySelector('.modal-footer')).toBeNull();
  expect([...document.querySelectorAll('span')].some(span => span.textContent === "cURL")).toBe(false);
  document.querySelector('pre')!.dispatchEvent(new Event("scroll"));
  expect(area.contains(copy())).toBe(true);
});
it("does not dismiss on panel/code clicks or a selection dragged out of the panel", async () => {
  await render();
  const panel = document.querySelector('[role="dialog"]')!;
  const preview = document.querySelector('pre')!;
  panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  preview.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  pointer(preview, "pointerdown");
  const backdrop = document.querySelector('.modal-backdrop')!;
  pointer(backdrop, "pointerup");
  // Browsers can send the drag's click to the common ancestor (backdrop).
  backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
  expect(wrapper!.emitted("close")).toBeUndefined();
});
it("selects code and gives manual copy guidance on clipboard failure", async () => {
  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("Denied"));
  await render(); copy().click(); await flushPromises();
  expect(api.select).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain("Cmd/Ctrl+C");
});
it("shows readable generation errors with Copy disabled", async () => {
  api.generate.mockRejectedValueOnce(new Error("A selected file was removed.")); await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("A selected file was removed.");
  expect(copy().disabled).toBe(true); expect(document.querySelector("pre")).toBeNull();
});
it.each(["escape", "x", "backdrop"])("dismisses by %s and restores opener focus on removal", async kind => {
  await render();
  if (kind === "escape") document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  else if (kind === "x") document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click();
  else clickBackdrop();
  await flushPromises(); expect(wrapper!.emitted("close")).toEqual([[]]);
  wrapper!.unmount(); wrapper = undefined; expect(document.activeElement).toBe(opener);
});
it.each(["success", "error"])("ignores late %s after closing while loading", async kind => {
  let finish!: (result: { code: string }) => void; let fail!: (error: Error) => void;
  api.generate.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  await render();
  document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flushPromises();
  if (kind === "success") finish({ code: "late code" }); else fail(new Error("late error"));
  await flushPromises(); expect(document.querySelector("pre")).toBeNull(); expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(wrapper!.emitted("close")).toEqual([[]]);
});
