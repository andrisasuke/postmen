import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { reactive } from "vue";
import ImportCollectionDialog from "./ImportCollectionDialog.vue";
import { emptyWorkspace } from "../types/data";

const api = vi.hoisted(() => ({ pick: vi.fn(), drop: vi.fn(), commit: vi.fn(), discard: vi.fn() }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const hooks = vi.hoisted(() => ({ workspace: vi.fn(), execution: vi.fn() }));
vi.mock("../services/collection-import", () => ({ collectionImport: api }));
vi.mock("../services/desktop", () => ({ isDesktop: () => true }));
vi.mock("../stores/workspace", () => ({ useWorkspaceStore: hooks.workspace }));
vi.mock("../stores/execution", () => ({ useExecutionStore: hooks.execution }));
vi.mock("../stores/notifications", () => ({ useNotificationsStore: () => notifications }));
let wrapper: VueWrapper;
const target = "target";
const preview = { token: "token", name: "Sample API Collection", requestCount: 2, folderCount: 0, variableCount: 0, warnings: ["Scripts are not executed."] };
let store: { environmentBusy: boolean; tabs: Record<string, { saving: boolean }>; dirty: ReturnType<typeof vi.fn>; descendants: ReturnType<typeof vi.fn>; applyImportedCollection: ReturnType<typeof vi.fn> };
let executions: { activeIds: string[]; states: Record<string, unknown> };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent.trim() === label)!;
const pick = async () => { document.querySelector<HTMLButtonElement>(".collection-dropzone")!.click(); await flushPromises(); };
async function collide() {
  api.commit.mockResolvedValueOnce({ status: "conflict", conflicts: [{ id: target, name: preview.name, requestCount: 3 }] });
  await pick(); button("Import").click(); await flushPromises();
}
beforeEach(async () => {
  vi.clearAllMocks();
  api.pick.mockReset().mockResolvedValue(preview); api.drop.mockReset().mockResolvedValue(preview);
  api.commit.mockReset(); api.discard.mockReset().mockResolvedValue(null);
  store = reactive({ environmentBusy: false, tabs: {}, dirty: vi.fn().mockReturnValue(false), descendants: vi.fn().mockReturnValue(["old"]), applyImportedCollection: vi.fn() });
  executions = reactive({ activeIds: [], states: { old: { phase: "done" } } });
  hooks.workspace.mockReturnValue(store); hooks.execution.mockReturnValue(executions);
  wrapper = mount(ImportCollectionDialog, { attachTo: document.body });
  await flushPromises();
});
afterEach(() => { wrapper.unmount(); document.body.replaceChildren(); });
it("previews the collection without writing and imports only after clicking Import", async () => {
  expect(button("Import").disabled).toBe(true);
  await pick();
  expect(document.body.textContent).toContain("Sample API Collection");
  expect(document.body.textContent).toContain("2 requests");
  expect(api.commit).not.toHaveBeenCalled();
  const outcome = { status: "imported", collectionId: "new", replacedId: null, workspace: emptyWorkspace() };
  api.commit.mockResolvedValueOnce(outcome);
  button("Import").click(); await flushPromises();
  expect(api.commit).toHaveBeenCalledWith("token", "create", null);
  expect(store.applyImportedCollection).toHaveBeenCalledWith(outcome);
  expect(wrapper.emitted("imported")).toEqual([["new"]]);
  expect(notifications.success).toHaveBeenCalledTimes(1);
});
it("defaults name conflicts to a copy, never overwrites without explicit choice", async () => {
  await collide();
  expect(document.querySelector<HTMLInputElement>('input[value="copy"]')!.checked).toBe(true);
  api.commit.mockResolvedValueOnce({ status: "imported", collectionId: "copy", replacedId: null, workspace: emptyWorkspace() });
  button("Import").click(); await flushPromises();
  expect(api.commit).toHaveBeenLastCalledWith("token", "copy", null);
});
it("blocks overwrite for dirty drafts and running requests, then replaces only the target", async () => {
  store.dirty.mockReturnValue(true);
  await collide();
  document.querySelector<HTMLInputElement>('input[value="overwrite"]')!.click(); await flushPromises();
  expect(button("Overwrite & Import").disabled).toBe(true);
  expect(document.body.textContent).toContain("unsaved drafts");
  // Re-evaluate computed guard through a reactive dependency.
  store.dirty.mockReturnValue(false); executions.activeIds.push("running"); await flushPromises();
  expect(button("Overwrite & Import").disabled).toBe(true);
  executions.activeIds = []; await flushPromises();
  api.commit.mockResolvedValueOnce({ status: "imported", collectionId: target, replacedId: target, workspace: emptyWorkspace() });
  button("Overwrite & Import").click(); await flushPromises();
  expect(api.commit).toHaveBeenLastCalledWith("token", "overwrite", target);
  expect(executions.states.old).toBeUndefined();
});
it("accepts one dropped file, rejects multiple files and prevents default navigation", async () => {
  const file = new File(["{}"], "collection.json");
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
  document.querySelector(".collection-dropzone")!.dispatchEvent(event); await flushPromises();
  expect(event.defaultPrevented).toBe(true); expect(api.drop).toHaveBeenCalledWith(file);
  const multiple = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(multiple, "dataTransfer", { value: { files: [file, file] } });
  document.querySelector(".collection-dropzone")!.dispatchEvent(multiple); await flushPromises();
  expect(api.drop).toHaveBeenCalledTimes(1); expect(button("Import").disabled).toBe(true);
  expect(document.body.textContent).toContain("one JSON collection file");
});
it("retains preview on failure, prevents duplicate commits and blocks dismiss while busy", async () => {
  await pick();
  api.commit.mockRejectedValueOnce(new Error("Disk unavailable"));
  button("Import").click(); await flushPromises();
  expect(document.body.textContent).toContain("Disk unavailable");
  expect(document.body.textContent).toContain(preview.name);
  let finish!: (value: unknown) => void;
  api.commit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  button("Import").click(); await flushPromises();
  button("Processing…").click(); button("Cancel").click();
  expect(api.commit).toHaveBeenCalledTimes(2);
  expect(wrapper.emitted("close")).toBeUndefined();
  finish({ status: "imported", collectionId: "new", replacedId: null, workspace: emptyWorkspace() }); await flushPromises();
});
it("cancels without importing and discards staged data on unmount", async () => {
  await pick(); button("Cancel").click(); await flushPromises();
  expect(wrapper.emitted("close")).toEqual([[]]);
  expect(api.commit).not.toHaveBeenCalled();
  wrapper.unmount();
  expect(api.discard).toHaveBeenCalledWith("token");
});
it("shows multiline variable diagnostics as plain text without enabling import", async () => {
  const message = 'Collection "My API" > Collection variables\nVariable #2 "bad name": Spaces are not allowed.\nReferenced by:\n- Folder "Users" > Request "<script>" — Headers (item[0].item[0].request)';
  api.pick.mockRejectedValueOnce(new Error(message));
  await pick();
  const diagnostic = document.querySelector(".import-diagnostic")!;
  expect(diagnostic.textContent).toBe(message);
  expect(diagnostic.querySelector("script")).toBeNull();
  expect(diagnostic.getAttribute("role")).toBe("alert");
  expect(button("Import").disabled).toBe(true);
  expect(api.commit).not.toHaveBeenCalled();
  expect(notifications.error).toHaveBeenCalledWith("Failed to read collection file");
});
