import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { reactive } from "vue";
import ExportCollectionDialog from "./ExportCollectionDialog.vue";

const api = vi.hoisted(() => ({ prepare: vi.fn(), pickDirectory: vi.fn(), commit: vi.fn(), discard: vi.fn() }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const workspace = vi.hoisted(() => vi.fn());
vi.mock("../services/collection-export", () => ({ collectionExport: api }));
vi.mock("../services/desktop", () => ({ isDesktop: () => true }));
vi.mock("../stores/workspace", () => ({ useWorkspaceStore: workspace }));
vi.mock("../stores/notifications", () => ({ useNotificationsStore: () => notifications }));
const files = [
  { id: "one", name: "Shopping", fileName: "Shopping", requestCount: 2, warnings: ["Review variables"] },
  { id: "two", name: "Other", fileName: "Other", requestCount: 1, warnings: [] },
];
let wrapper: VueWrapper;
let store: { activeCollectionId: string | null; environmentBusy: boolean; data: { collections: { id: string; name: string; position: number }[] }; tabs: Record<string, { draft: { id: string; collectionId: string }; saving: boolean }>; dirty: ReturnType<typeof vi.fn> };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent.trim() === label)!;
async function next() { button("Next").click(); await flushPromises(); }
async function browse() { button("Browse").click(); await flushPromises(); }
async function submit() { button("Export").click(); await flushPromises(); }
beforeEach(async () => {
  vi.clearAllMocks();
  api.prepare.mockReset().mockImplementation(async (ids: string[]) => ({ token: "token", files: files.filter(file => ids.includes(file.id)).map(file => ({ ...file })) }));
  api.pickDirectory.mockReset().mockResolvedValue("/chosen/exports");
  api.commit.mockReset().mockResolvedValue({ status: "exported", written: ["one"], failed: [] });
  api.discard.mockReset().mockResolvedValue(null);
  store = reactive({ activeCollectionId: "one", environmentBusy: false, data: { collections: files.map((file,position) => ({ id: file.id, name: file.name, position })) }, tabs: {}, dirty: vi.fn().mockReturnValue(false) });
  workspace.mockReturnValue(store);
  wrapper = mount(ExportCollectionDialog, { attachTo: document.body });
  await flushPromises();
});
afterEach(() => { wrapper.unmount(); document.body.replaceChildren(); });

it("selects collections first, then shows the name/location form without writing", async () => {
  expect(document.querySelector('h2')?.textContent).toBe("Export Collections");
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Export Shopping"]')!.checked).toBe(true);
  await next();
  expect(api.prepare).toHaveBeenCalledWith(["one"], true);
  expect(document.querySelector('h2')?.textContent).toBe("Export to Postman");
  expect(document.querySelector<HTMLInputElement>('input[data-file-name]')!.value).toBe("Shopping");
  expect(button("Export").disabled).toBe(true);
  expect(api.commit).not.toHaveBeenCalled();
  await browse(); await submit();
  expect(api.commit).toHaveBeenCalledWith("token", [{ id: "one", name: "Shopping" }], false);
  expect(notifications.success).toHaveBeenCalledTimes(1);
  expect(wrapper.emitted("close")).toEqual([[]]);
});

it("supports multi-select, editable per-collection names and opting out of variables", async () => {
  const inputs = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  inputs[0]!.click(); inputs[inputs.length-1]!.click(); await flushPromises();
  await next();
  expect(api.prepare).toHaveBeenCalledWith(["one","two"], false);
  expect(document.querySelectorAll('[data-file-name]')).toHaveLength(2);
  const name = document.querySelector<HTMLInputElement>('input[aria-label="File name for Other"]')!;
  name.value = "Other-copy"; name.dispatchEvent(new Event("input", { bubbles: true })); await flushPromises();
  await browse();
  api.commit.mockResolvedValueOnce({ status: "exported", written: ["one","two"], failed: [] });
  await submit();
  expect(api.commit).toHaveBeenCalledWith("token", [{ id: "one", name: "Shopping" }, { id: "two", name: "Other-copy" }], false);
});

it("requires Yes before overwrite, while No retains name/location without another write", async () => {
  await next(); await browse();
  api.commit.mockResolvedValueOnce({ status: "conflict", files: ["Shopping.json"] });
  await submit();
  expect(document.body.textContent).toContain("Replace existing files?");
  expect(document.activeElement).toBe(button("No"));
  button("No").click(); await flushPromises();
  expect(api.commit).toHaveBeenCalledTimes(1);
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Export location"]')!.value).toBe("/chosen/exports");
  api.commit.mockResolvedValueOnce({ status: "conflict", files: ["Shopping.json"] });
  await submit();
  button("Yes, overwrite").click(); await flushPromises();
  expect(api.commit).toHaveBeenLastCalledWith("token", [{ id: "one", name: "Shopping" }], true);
});

it("blocks dirty selected drafts but not unrelated ones", async () => {
  store.tabs.pending = { draft: { id: "pending", collectionId: "one" }, saving: true };
  await flushPromises();
  expect(button("Next").disabled).toBe(true);
  expect(document.body.textContent).toContain("unsaved drafts");
  store.tabs.pending.draft.collectionId = "two"; await flushPromises();
  expect(button("Next").disabled).toBe(false);
  await next();
  expect(api.prepare).toHaveBeenCalledTimes(1);
});

it("handles picker cancel and Back/Cancel without saving any files", async () => {
  await next(); api.pickDirectory.mockResolvedValueOnce(null); await browse();
  expect(button("Export").disabled).toBe(true);
  button("Back").click(); await flushPromises();
  expect(api.discard).toHaveBeenCalledWith("token");
  expect(document.querySelector('h2')?.textContent).toBe("Export Collections");
  button("Cancel").click(); await flushPromises();
  expect(wrapper.emitted("close")).toEqual([[]]);
  expect(api.commit).not.toHaveBeenCalled();
});

it("keeps successfully written files and retries only failed collections", async () => {
  document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); await flushPromises();
  await next(); await browse();
  api.commit.mockResolvedValueOnce({ status: "exported", written: ["one"], failed: [{ id: "two", message: "Disk unavailable" }] });
  await submit();
  expect(document.body.textContent).toContain("1 file(s) already exported");
  expect(document.body.textContent).toContain("Other: Disk unavailable");
  expect(document.querySelectorAll('[data-file-name]')).toHaveLength(1);
  expect(wrapper.emitted("close")).toBeUndefined();
  api.commit.mockResolvedValueOnce({ status: "exported", written: ["two"], failed: [] });
  await submit();
  expect(api.commit).toHaveBeenLastCalledWith("token", [{ id: "two", name: "Other" }], false);
});

it("blocks repeat submission and dismissal while writing and retains error details", async () => {
  await next(); await browse();
  let finish!: () => void;
  api.commit.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ status: "exported", written: ["one"], failed: [] }); }));
  await submit();
  expect(button("Processing…").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(wrapper.emitted("close")).toBeUndefined();
  expect(api.commit).toHaveBeenCalledTimes(1);
  finish(); await flushPromises();
  expect(wrapper.emitted("close")).toHaveLength(1);
});
