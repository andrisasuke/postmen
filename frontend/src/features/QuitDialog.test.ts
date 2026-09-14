import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import QuitDialog from "./QuitDialog.vue";
import { createMemoryApi } from "../fixtures/memory-api";
import { useWorkspaceStore } from "../stores/workspace";
import { useExecutionStore } from "../stores/execution";
import { useSettingsStore } from "../stores/settings";
import type { DataApi } from "../types/data";
const native = vi.hoisted(() => ({
  finish: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
}));
vi.mock("../services/desktop", () => ({ isDesktop: () => true }));
vi.mock("../services/execution", () => ({
  finishQuit: native.finish,
  cancelQuit: native.cancel,
}));
describe("M3 unified Quit", () => {
  let pinia: ReturnType<typeof createPinia>,
    store: ReturnType<typeof useWorkspaceStore>,
    api: DataApi,
    wrapper: VueWrapper;
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    pinia = createPinia();
    setActivePinia(pinia);
    api = createMemoryApi();
    store = useWorkspaceStore();
    await store.initialize(api);
    const c = await store.createCollection("QA");
    const a = await store.createRequest(
      { collectionId: c.id, parentId: null },
      "Alpha",
    );
    const b = await store.createRequest(
      { collectionId: c.id, parentId: null },
      "Beta",
    );
    store.tabs[a.id]!.draft.url = "/alpha";
    store.tabs[b.id]!.draft.url = "/beta";
    wrapper = mount(QuitDialog, {
      props: { open: true },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await nextTick();
  });
  afterEach(() => {
    wrapper.unmount();
    disposePinia(pinia);
    vi.unstubAllGlobals();
  });
  async function click(label: string) {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((e) => e.textContent.trim() === label);
    expect(button).toBeTruthy();
    button!.click();
    await flushPromises();
  }
  it("Cancel preserves every draft and clears native close request", async () => {
    await click("Cancel");
    expect(native.cancel).toHaveBeenCalledOnce();
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(store.dirtyIds).toHaveLength(2);
    expect(native.finish).not.toHaveBeenCalled();
  });
  it("saves all dirty tabs, cancels HTTP and flushes state before exit", async () => {
    const cancel = vi.spyOn(useExecutionStore(), "cancelAll");
    await click("Save All and Quit");
    expect(store.hasDirty).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(native.finish).toHaveBeenCalledWith(false);
    expect((await api.loadWorkspace()).session.tabIds).toHaveLength(2);
  });
  it("failed save keeps app open and drafts intact with no skip-save escape", async () => {
    vi.spyOn(api, "saveRequest").mockRejectedValueOnce(new Error("Disk full"));
    await click("Save All and Quit");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Disk full",
    );
    expect(store.dirtyIds).toHaveLength(2);
    expect(native.finish).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      "Quit without saving state",
    );
  });
  it("explicit discard quits without overwriting saved requests", async () => {
    const save = vi.spyOn(api, "saveRequest");
    await click("Discard and Quit");
    expect(save).not.toHaveBeenCalled();
    expect(native.finish).toHaveBeenCalledWith(false);
    expect(store.dirtyIds).toHaveLength(2);
  });
  it("session failure permits only an explicit state-discard exit", async () => {
    vi.spyOn(store, "persistSession").mockResolvedValue(false);
    await click("Discard and Quit");
    expect(native.finish).not.toHaveBeenCalled();
    await click("Discard and Quit without saving state");
    expect(native.finish).toHaveBeenCalledWith(true);
  });
  it("window persistence failure keeps drafts available when Cancel is chosen", async () => {
    native.finish.mockRejectedValueOnce(new Error("Window state unavailable"));
    await click("Discard and Quit");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Window state unavailable",
    );
    await click("Cancel");
    expect(store.dirtyIds).toHaveLength(2);
  });
  it("retries preference persistence before deciding to quit", async () => {
    const settings = useSettingsStore();
    settings.persistenceError = "Previous failure";
    await click("Save All and Quit");
    expect(settings.persistenceError).toBe("");
    expect(native.finish).toHaveBeenCalledWith(false);
  });
  it("does not quit while another save or bootstrap is in flight", async () => {
    store.loading = true;
    await nextTick();
    await click("Save All and Quit");
    expect(native.finish).not.toHaveBeenCalled();
  });
});
