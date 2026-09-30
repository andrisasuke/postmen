import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { createMemoryApi } from "../fixtures/memory-api";
import { useWorkspaceStore } from "../stores/workspace";
import { useExecutionStore } from "../stores/execution";
import { clone, type RequestDoc } from "../types/data";
import RequestEditor from "./RequestEditor.vue";

let pinia: ReturnType<typeof createPinia>;
let store: ReturnType<typeof useWorkspaceStore>;
let api: ReturnType<typeof createMemoryApi>;
let wrapper: VueWrapper;
let a: RequestDoc; let b: RequestDoc;
const stubs = { SplitPanes: { template: '<div><slot name="request" /></div>' }, ResponsePanel: true, VariableInput: true, KeyValueTable: true, CodeEditor: true, MultipartEditor: true };
const save = () => wrapper.get('button.save-request-button');
const blue = () => save().classes().includes("save-request-dirty");
beforeEach(async () => {
  localStorage.clear(); pinia = createPinia(); setActivePinia(pinia);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  api = createMemoryApi(); store = useWorkspaceStore(); await store.initialize(api);
  const c = await store.createCollection("Synthetic"); const parent = { collectionId: c.id, parentId: null };
  a = await store.createRequest(parent, "A"); b = await store.createRequest(parent, "B");
  wrapper = mount(RequestEditor, { props: { id: a.id }, global: { plugins: [pinia], stubs } });
});
afterEach(() => { wrapper.unmount(); disposePinia(pinia); vi.unstubAllGlobals(); });
it("places Generate immediately before Save and emits only the request ID", async () => {
  const generate = wrapper.get('[aria-label="Generate cURL"]');
  expect(generate.element.nextElementSibling).toBe(save().element);
  const draft = clone(store.tabs[a.id]!.draft); const persist = vi.spyOn(api, "saveRequest"); const send = vi.spyOn(useExecutionStore(), "send");
  await generate.trigger("click");
  expect(wrapper.emitted("generate-code")).toEqual([[a.id]]);
  expect(persist).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(store.tabs[a.id]!.draft).toEqual(draft); expect(store.dirty(a.id)).toBe(false);
  store.environmentBusy = true; await flushPromises(); expect((generate.element as HTMLButtonElement).disabled).toBe(true);
});
it("tracks clean, dirty, button save in flight and clean success", async () => {
  expect(blue()).toBe(false); store.tabs[a.id]!.draft.url = "https://example.test/changed"; await flushPromises(); expect(blue()).toBe(true);
  const original = api.saveRequest.bind(api); let finish!: () => void;
  vi.spyOn(api, "saveRequest").mockImplementationOnce(input => new Promise(resolve => { finish = async () => resolve(await original(input)); }));
  await save().trigger("click");
  expect(blue()).toBe(false); expect(save().attributes("disabled")).toBeDefined(); expect(save().attributes("aria-label")).toBe("Saving request");
  finish(); await flushPromises(); expect(blue()).toBe(false); expect(store.dirty(a.id)).toBe(false);
});
it("restores blue after a failed save without losing changes", async () => {
  store.tabs[a.id]!.draft.body = "unsaved"; await flushPromises();
  let fail!: (reason: Error) => void;
  vi.spyOn(api, "saveRequest").mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await save().trigger("click"); expect(blue()).toBe(false);
  fail(new Error("Storage unavailable")); await flushPromises(); expect(blue()).toBe(true); expect(store.dirty(a.id)).toBe(true);
});
it("programmatic save stays gray during newer edits and becomes blue after completion", async () => {
  store.tabs[a.id]!.draft.body = "first";
  const original = api.saveRequest.bind(api); let finish!: () => void;
  vi.spyOn(api, "saveRequest").mockImplementationOnce(input => new Promise(resolve => { finish = async () => resolve(await original(input)); }));
  const operation = store.save(a.id); await flushPromises(); expect(blue()).toBe(false);
  store.tabs[a.id]!.draft.body = "newer"; await flushPromises(); expect(blue()).toBe(false);
  finish(); expect(await operation).toBe(false); await flushPromises(); expect(blue()).toBe(true);
  await store.save(a.id); await flushPromises(); expect(blue()).toBe(false);
});
it("undo to saved values and discard both restore gray", async () => {
  const tab = store.tabs[a.id]!; tab.draft.body = "change"; await flushPromises(); expect(blue()).toBe(true);
  tab.draft.body = tab.saved.body; await flushPromises(); expect(blue()).toBe(false);
  tab.draft.url = "change"; await flushPromises(); expect(blue()).toBe(true);
  store.discard(a.id); await flushPromises(); expect(blue()).toBe(false);
});
it("keeps color independent per request when switching", async () => {
  store.tabs[a.id]!.draft.body = "dirty A"; await flushPromises(); expect(blue()).toBe(true);
  store.activate(b.id); await wrapper.setProps({ id: b.id }); expect(blue()).toBe(false);
  store.activate(a.id); await wrapper.setProps({ id: a.id }); expect(blue()).toBe(true);
});
it("ignores section, selection, scroll and pane layout changes", async () => {
  store.updateView(a.id, { section: "headers", selection: { anchor: 2, head: 5 }, scroll: { top: 40, left: 20 }, pane: { ...store.tabs[a.id]!.view.pane, orientation: "vertical", requestHeight: 500 } });
  await flushPromises(); expect(blue()).toBe(false); expect(store.dirty(a.id)).toBe(false);
});
