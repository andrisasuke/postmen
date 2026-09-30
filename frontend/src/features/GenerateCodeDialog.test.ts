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
async function render() {
  wrapper = mount(GenerateCodeDialog, { props: { request }, attachTo: document.body, global: { stubs: { ShellPreview } } });
  await flushPromises();
}
beforeEach(async () => {
  vi.clearAllMocks(); api.generate.mockReset().mockResolvedValue({ code });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  const memory = createMemoryApi(); const c = await memory.createCollection("Synthetic");
  request = await memory.createRequest({ collectionId: c.id, folderId: null, name: "Synthetic" });
  opener = document.createElement("button"); document.body.append(opener); opener.focus();
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; document.body.replaceChildren(); });
it("shows loading with Copy disabled, then renders generated code", async () => {
  let finish!: (value: { code: string }) => void;
  api.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  expect(document.body.textContent).toContain("Generating cURL…"); expect(copy().disabled).toBe(true);
  expect(document.querySelector("h2")?.textContent).toBe("Generate Code");
  finish({ code }); await flushPromises();
  expect(copy().disabled).toBe(false); expect(document.querySelector("pre")?.textContent).toBe(code);
});
it("copies exact source without line numbers and reports Copied", async () => {
  await render(); copy().click(); await flushPromises();
  expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(code);
  expect(document.body.textContent).toContain("Copied");
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
it.each(["escape", "close"])("dismisses by %s and restores opener focus on removal", async kind => {
  await render();
  if (kind === "escape") document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  else [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent.trim() === "Close")!.click();
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
