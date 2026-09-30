import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { defineComponent } from "vue";
import { createMemoryApi } from "../fixtures/memory-api";
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
