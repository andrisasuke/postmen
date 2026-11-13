import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { defineComponent } from "vue";
import { createMemoryApi } from "../fixtures/memory-api";
import { createExecutionFixture } from "../fixtures/execution-api";
import { DataError } from "../services/data";
import type { WorkspaceCatalog, WorkspacesApi } from "../services/workspaces";
import { clone, newRow, type RequestDoc } from "../types/data";
import { useWorkspaceStore } from "../stores/workspace";
import { useWorkspacesStore } from "../stores/workspaces";
import { useExecutionStore } from "../stores/execution";
import WorkspaceApp from "./WorkspaceApp.vue";

const native = vi.hoisted(() => ({ generate: vi.fn(), action: undefined as ((value: string) => void) | undefined }));
vi.mock("../services/generate-code", () => ({ generateCurl: native.generate }));
vi.mock("../services/desktop", async importOriginal => ({
  ...await importOriginal<typeof import("../services/desktop")>(),
  bootstrapDesktop: async () => null,
  isDesktop: () => false,
  setWindowTheme: async () => {},
  onShellAction: async (callback: (value: string) => void) => { native.action = callback; return () => {}; },
}));
const ShellPreview = defineComponent({ props: ["code"], template: '<pre>{{ code }}</pre>' });
let pinia: ReturnType<typeof createPinia>;
let store: ReturnType<typeof useWorkspaceStore>;
let api: ReturnType<typeof createMemoryApi>;
let wrapper: VueWrapper;
let a: RequestDoc; let b: RequestDoc;
const code = "curl --globoff \\\n  --url 'https://example.test'";
const generate = () => wrapper.get('[aria-label="Generate cURL"]');
function shortcut(key: string) { window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true })); }
beforeEach(async () => {
  localStorage.clear(); vi.clearAllMocks(); native.generate.mockReset().mockResolvedValue({ code });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  pinia = createPinia(); setActivePinia(pinia); api = createMemoryApi(); store = useWorkspaceStore(); await store.initialize(api);
  const c = await store.createCollection("Synthetic"); const parent = { collectionId: c.id, parentId: null };
  a = await store.createRequest(parent, "A"); b = await store.createRequest(parent, "B"); store.activate(a.id);
  wrapper = mount(WorkspaceApp, { attachTo: document.body, global: { plugins: [pinia], stubs: {
    TitleBar: { template: '<div><slot name="workspace" /></div>' },
    WorkspaceSelector: true, WorkspaceSidebar: true, WorkspaceManager: true, WorkspaceOverview: true,
    EnvironmentSelector: true, StatusBar: true, QuitDialog: true, ToastHost: true,
    SplitPanes: { template: '<div><slot name="request" /></div>' },
    VariableInput: true, KeyValueTable: true, MultipartEditor: true, CodeEditor: true, ResponsePanel: true, ShellPreview,
  } } });
  await flushPromises();
});
afterEach(() => { wrapper.unmount(); disposePinia(pinia); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("generates the freshest unsaved snapshot and Copy never saves, sends or mutates drafts/history", async () => {
  const draft = store.tabs[a.id]!.draft;
  draft.url = "https://example.test?inline=1"; draft.params = [{ ...newRow(), name: "stored", value: "2" }];
  draft.bodyKind = "json"; draft.body = "unsaved\nbody";
  draft.headers = [{ ...newRow(), name: "X-Test", value: "unsaved" }];
  const before = clone(draft); const saved = clone(store.tabs[a.id]!.saved);
  const save = vi.spyOn(api, "saveRequest"); const send = vi.spyOn(useExecutionStore(), "send");
  const states = clone(useExecutionStore().states);
  await generate().trigger("click"); await flushPromises();
  expect(native.generate).toHaveBeenCalledExactlyOnceWith(before);
  const snapshot = native.generate.mock.calls[0]![0] as RequestDoc;
  expect(snapshot).not.toBe(draft); expect(snapshot.headers).not.toBe(draft.headers);
  document.querySelector<HTMLButtonElement>('[aria-label="Copy cURL"]')!.click(); await flushPromises();
  expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(code);
  expect(save).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(store.tabs[a.id]!.draft).toEqual(before); expect(store.tabs[a.id]!.saved).toEqual(saved);
  expect(store.dirty(a.id)).toBe(true); expect(useExecutionStore().states).toEqual(states);
  draft.body = "changed after opening";
  expect(snapshot.body).toBe("unsaved\nbody");
  expect(snapshot.url).toBe("https://example.test?inline=1"); expect(snapshot.params).toEqual(before.params);
});

it("guards Save/Send, native actions, request tabs and workspace switching while the modal is open", async () => {
  const save = vi.spyOn(store, "save"); const send = vi.spyOn(useExecutionStore(), "send");
  const change = vi.spyOn(useWorkspacesStore(), "change");
  await generate().trigger("click"); await flushPromises();
  for (const key of ["s", "Enter", "Tab"]) shortcut(key);
  for (const action of ["save-request", "send-request", "next-request", "previous-request"]) native.action!(action);
  await wrapper.get(`[data-request-tab="${b.id}"]`).trigger("click");
  await wrapper.get(`[data-request-tab="${a.id}"]`).trigger("keydown", { key: "ArrowRight" });
  const selector = wrapper.findComponent({ name: "WorkspaceSelector" });
  expect(selector.props("disabled")).toBe(true);
  selector.vm.$emit("select", "another-workspace"); await flushPromises();
  expect(change).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(store.activeId).toBe(a.id);
  document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flushPromises();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  shortcut("Tab"); await flushPromises(); expect(store.activeId).toBe(b.id);
});

it("returns focus to Generate after closing and ignores an earlier dialog's completion after reopening", async () => {
  let finish!: (value: { code: string }) => void;
  native.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await generate().trigger("click"); await flushPromises();
  document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flushPromises();
  expect(document.activeElement).toBe(generate().element);
  await generate().trigger("click"); await flushPromises();
  finish({ code: "stale code" }); await flushPromises();
  expect(document.querySelector("pre")?.textContent).toBe(code);
});

it("blocks generation during environment changes even if the event is emitted programmatically", async () => {
  store.environmentBusy = true; await flushPromises();
  wrapper.findComponent({ name: "RequestEditor" }).vm.$emit("generate-code", a.id); await flushPromises();
  expect(native.generate).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("shortcut Save updates the same Save icon status throughout pending save", async () => {
  store.tabs[a.id]!.draft.body = "unsaved"; await flushPromises();
  const button = () => wrapper.get('.save-request-button');
  expect(button().classes()).toContain("save-request-dirty");
  let finish!: () => void; const original = api.saveRequest.bind(api);
  vi.spyOn(api, "saveRequest").mockImplementationOnce(input => new Promise(resolve => { finish = async () => resolve(await original(input)); }));
  shortcut("s"); await flushPromises(); expect(button().classes()).not.toContain("save-request-dirty");
  expect(button().attributes("aria-label")).toBe("Saving request");
  finish(); await flushPromises(); expect(button().classes()).not.toContain("save-request-dirty"); expect(store.dirty(a.id)).toBe(false);
});
it("shows only dirty selected requests and Save All & Move saves and moves them", async () => {
  store.tabs[a.id]!.draft.body = "unsaved";
  const folder = await store.createFolder({ collectionId: a.collectionId, parentId: null }, "Destination");
  const target = await store.createRequest({ collectionId: a.collectionId, parentId: folder.id }, "Target");
  wrapper.findComponent({ name: "WorkspaceSidebar" }).vm.$emit("move-requests", [a.id, b.id, target.id], { kind: "request", targetFolderId: folder.id, anchorId: target.id, insertAfter: false });
  await flushPromises();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(a.name);
  expect(dialog.textContent).not.toContain(b.name);
  expect(dialog.textContent).toContain("Save All & Move");
  const save = vi.spyOn(api, "saveAndMoveRequests");
  Array.from(dialog.querySelectorAll("button")).find(button => button.textContent?.includes("Save All & Move"))!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
  expect(save).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ anchorId: target.id, insertAfter: false }));
  expect(store.data.requests.find(request => request.id === a.id)?.folderId).toBe(folder.id);
  expect(store.data.requests.find(request => request.id === b.id)?.folderId).toBe(folder.id);
  expect(store.data.requests.find(request => request.id === target.id)?.folderId).toBe(folder.id);
  expect(store.siblings({ kind: "request", id: target.id }).map(item => item.id)).toEqual([a.id, b.id, target.id]);
});
it("cancelling the Save All & Move dialog leaves dirty drafts and folders unchanged", async () => {
  const folder = await store.createFolder({ collectionId: a.collectionId, parentId: null }, "Destination");
  await store.moveToFolder({ kind: "request", id: a.id }, folder.id);
  const target = await store.createRequest({ collectionId: a.collectionId, parentId: folder.id }, "Target");
  store.tabs[a.id]!.draft.body = "keep draft";
  wrapper.findComponent({ name: "WorkspaceSidebar" }).vm.$emit("move-requests", [a.id], { kind: "request", targetFolderId: null, anchorId: target.id, insertAfter: false });
  await flushPromises();
  Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent === "Cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
  expect(store.tabs[a.id]!.draft.body).toBe("keep draft");
  expect(store.data.requests.find(request => request.id === a.id)?.folderId).toBe(folder.id);
  expect(store.siblings({ kind: "request", id: target.id }).map(item => item.id)).toContain(target.id);
});

it("restores the startup-visible request when execution becomes ready and restores another on tab activation", async () => {
  const execution = createExecutionFixture();
  const read = vi.spyOn(execution, "getLastExecution").mockImplementation(async id => ({ completedAt: 123, result: {
    executionId: crypto.randomUUID(), requestId: id, outcome: "success", status: 200, statusText: "OK",
    headers: [], headersTruncated: false, body: id, bodyEncoding: "UTF-8", binary: false,
    previewBytes: id.length, truncated: false, durationMs: 1, errorCode: null, message: null, historyWarning: null,
  } }));
  const send = vi.spyOn(execution, "execute");
  useExecutionStore().initialize(execution); await flushPromises();
  expect(read).toHaveBeenCalledExactlyOnceWith(a.id);
  expect(useExecutionStore().states[a.id]?.result?.body).toBe(a.id);
  await wrapper.get(`[data-request-tab="${b.id}"]`).trigger("click"); await flushPromises();
  expect(read).toHaveBeenLastCalledWith(b.id);
  expect(useExecutionStore().states[b.id]?.result?.body).toBe(b.id);
  expect(send).not.toHaveBeenCalled();
});

it("closes only other tabs after one target-scoped confirmation and persists the keep tab", async () => {
  store.tabs[b.id]!.draft.body = "unsaved target";
  const menu = wrapper.findAllComponents({ name: "UiMenu" }).find(item => item.props("label") === "Request tab actions")!;
  await wrapper.get(`[data-request-tab="${b.id}"]`).trigger("contextmenu", { clientX: 8, clientY: 8 });
  menu.vm.$emit("select", "close-others"); await flushPromises();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(b.name);
  expect(dialog.textContent).not.toContain(a.name);
  expect(store.tabIds).toEqual([a.id, b.id]);
  const discard = Array.from(dialog.querySelectorAll("button")).find(button => button.textContent?.includes("Discard and Close Others"))!;
  discard.click(); await flushPromises();
  expect(store.tabIds).toEqual([b.id]); expect(store.activeId).toBe(b.id);
  expect(store.tabs[b.id]!.draft.body).toBe("unsaved target");
  expect(api.loadWorkspace && (await api.loadWorkspace()).session).toMatchObject({ tabIds: [b.id], activeId: b.id });
});

it("keeps every tab and draft open when final session persistence fails", async () => {
  store.tabs[a.id]!.draft.body = "preserve a"; store.tabs[b.id]!.draft.body = "preserve b";
  const saveSession = vi.spyOn(api, "saveSession").mockRejectedValueOnce(new Error("session unavailable"));
  const menu = wrapper.findAllComponents({ name: "UiMenu" }).find(item => item.props("label") === "Request tab actions")!;
  await wrapper.get(`[data-request-tab="${a.id}"]`).trigger("contextmenu", { clientX: 8, clientY: 8 });
  menu.vm.$emit("select", "close-others"); await flushPromises();
  const dialog = document.querySelector('[role="dialog"]')!;
  Array.from(dialog.querySelectorAll("button")).find(button => button.textContent === "Discard and Close Others")!.click();
  await flushPromises();
  expect(saveSession).toHaveBeenCalled(); expect(store.tabIds).toEqual([a.id, b.id]);
  expect(store.tabs[a.id]!.draft.body).toBe("preserve a"); expect(store.tabs[b.id]!.draft.body).toBe("preserve b");
  expect(dialog.textContent).toContain("session unavailable");
});

it("confirms target cancellation and preserves the kept tab execution", async () => {
  const executions = useExecutionStore();
  const execution = createExecutionFixture();
  executions.initialize(execution);
  executions.states[a.id] = { executionId: "keep-running", phase: "running", startedAt: 0, result: null, failure: "", section: "response", format: "formatted", cancelRequested: false };
  executions.states[b.id] = { executionId: "target-running", phase: "running", startedAt: 0, result: null, failure: "", section: "response", format: "formatted", cancelRequested: false };
  const cancel = vi.spyOn(execution, "cancel");
  const menu = wrapper.findAllComponents({ name: "UiMenu" }).find(item => item.props("label") === "Request tab actions")!;
  await wrapper.get(`[data-request-tab="${a.id}"]`).trigger("contextmenu", { clientX: 8, clientY: 8 });
  menu.vm.$emit("select", "close-others"); await flushPromises();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("1 target request(s) will be cancelled");
  expect(store.tabIds).toHaveLength(2);
  Array.from(dialog.querySelectorAll("button")).find(button => button.textContent?.includes("Cancel Requests and Close Others"))!.click();
  await flushPromises();
  expect(cancel).toHaveBeenCalledExactlyOnceWith("target-running");
  expect(store.tabIds).toEqual([a.id]); expect(store.activeId).toBe(a.id);
  expect(executions.states[a.id]?.executionId).toBe("keep-running");
  expect(executions.states[b.id]).toBeUndefined();
});

it("restores the visible request after a workspace switch and after ambiguous switch recovery", async () => {
  const executions = useExecutionStore();
  const execution = createExecutionFixture();
  const read = vi.spyOn(execution, "getLastExecution").mockResolvedValue(null);
  executions.initialize(execution); await flushPromises();
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  const catalog: WorkspaceCatalog = { version: 1, activeId: first, defaultId: first,
    workspaces: [{ id: first, name: "First" }, { id: second, name: "Second" }] };
  const activation = async () => {
    const data = await api.loadWorkspace();
    return { catalog: clone(catalog), workspace: data, documents: await Promise.all(data.session.tabIds.map(id => api.getRequest(id))) };
  };
  const workspacesApi: WorkspacesApi = {
    list: async () => clone(catalog),
    select: async id => { catalog.activeId = id; return activation(); },
    create: async () => { throw new Error("unused"); },
    setDefault: async () => { throw new Error("unused"); },
    remove: async () => { throw new Error("unused"); },
  };
  const workspaces = useWorkspacesStore(); await workspaces.initialize(workspacesApi);
  await store.persistSession();
  expect(await workspaces.change(second)).toBe(true); await flushPromises();
  expect(read).toHaveBeenCalledTimes(2);
  const select = workspacesApi.select;
  vi.spyOn(workspacesApi, "select").mockImplementationOnce(async id => { await select(id); throw new DataError("IPC_ERROR", "Lost response"); });
  expect(await workspaces.change(first)).toBe(false); await flushPromises();
  expect(workspaces.needsRecovery).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  await workspaces.recover(); await flushPromises();
  expect(workspaces.needsRecovery).toBe(false);
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenLastCalledWith(a.id);
});
