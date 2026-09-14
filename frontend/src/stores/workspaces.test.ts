import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { createMemoryApi } from "../fixtures/memory-api";
import { clone, type DataApi } from "../types/data";
import { DataError } from "../services/data";
import type { WorkspaceActivation, WorkspaceCatalog, WorkspacesApi } from "../services/workspaces";
import { useWorkspaceStore } from "./workspace";
import { useWorkspacesStore } from "./workspaces";
import { useExecutionStore } from "./execution";

const originalId = "00000000-0000-4000-8000-000000000001";
let pinia: ReturnType<typeof createPinia>;
let store: ReturnType<typeof useWorkspaceStore>;
let workspaces: ReturnType<typeof useWorkspacesStore>;
let registry: WorkspaceCatalog;
let services: Map<string, DataApi>;
let api: WorkspacesApi;
async function activation(): Promise<WorkspaceActivation> {
  const service = services.get(registry.activeId)!;
  const workspace = await service.loadWorkspace();
  return { catalog: clone(registry), workspace,
    documents: await Promise.all(workspace.session.tabIds.map(id => service.getRequest(id))) };
}
beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  pinia = createPinia(); setActivePinia(pinia);
  store = useWorkspaceStore(); workspaces = useWorkspacesStore();
  registry = { version: 1, activeId: originalId, defaultId: originalId, workspaces: [{ id: originalId, name: "My Workspace" }] };
  services = new Map([[originalId, createMemoryApi()]]);
  api = {
    list: vi.fn(async () => clone(registry)),
    create: vi.fn(async name => {
      if (registry.workspaces.some(entry => entry.name.toLowerCase() === name.toLowerCase())) {
        throw new DataError("INVALID_INPUT", "A workspace with this name already exists.");
      }
      const id = crypto.randomUUID();
      registry.workspaces.push({ id, name }); registry.activeId = id;
      services.set(id, createMemoryApi());
      return activation();
    }),
    select: vi.fn(async id => { registry.activeId = id; return activation(); }),
    setDefault: vi.fn(async id => { registry.defaultId = id; return clone(registry); }),
    remove: vi.fn(async id => {
      if (id === registry.defaultId) throw new DataError("PROTECTED_WORKSPACE", "The default workspace cannot be deleted.");
      const active = id === registry.activeId;
      registry.workspaces = registry.workspaces.filter(entry => entry.id !== id);
      if (active) registry.activeId = registry.defaultId;
      return { catalog: clone(registry), activation: active ? await activation() : null };
    }),
  };
  const router = new Proxy({} as DataApi, { get: (_target, key) => (...args: unknown[]) => {
    const service = services.get(registry.activeId)!;
    return Reflect.apply(Reflect.get(service, key), service, args);
  } });
  await store.initialize(router);
  await workspaces.initialize(api);
});
afterEach(() => { disposePinia(pinia); vi.unstubAllGlobals(); });
async function request() {
  const collection = await store.createCollection("Original collection");
  return store.createRequest({ collectionId: collection.id, parentId: null }, "Original request");
}
it("does not create or change selection when a workspace name draft is cancelled", () => {
  workspaces.beginCreate();
  expect(workspaces.draftName).toBe("Untitled Workspace");
  workspaces.draftName = "Shopping";
  workspaces.cancelCreate();
  expect(workspaces.catalog?.activeId).toBe(originalId);
  expect(api.create).not.toHaveBeenCalled();
});
it("creates an empty workspace and restores independent tabs, content and environments on switching back", async () => {
  const doc = await request();
  await store.saveEnvironment({ id: null, collectionId: null, name: "Original global", variables: [], revision: null });
  workspaces.beginCreate(); workspaces.draftName = " Shopping ";
  expect(await workspaces.change()).toBe(true);
  expect(api.create).toHaveBeenCalledWith("Shopping");
  expect(workspaces.activeName).toBe("Shopping");
  expect(store.data.collections).toEqual([]);
  expect(store.data.environments).toEqual([]);
  expect(store.tabIds).toEqual([]);
  expect(store.activeId).toBeNull();
  expect(await workspaces.change(originalId)).toBe(true);
  expect(store.data.collections[0]?.name).toBe("Original collection");
  expect(store.data.environments[0]?.name).toBe("Original global");
  expect(store.tabIds).toEqual([doc.id]);
  expect(store.activeId).toBe(doc.id);
  expect(store.dirty(doc.id)).toBe(false);
});
it("rejects switching while requests are dirty or running without losing drafts", async () => {
  const doc = await request();
  const otherId = crypto.randomUUID();
  store.tabs[doc.id]!.draft.body = "unsaved";
  expect(await workspaces.change(otherId)).toBe(false);
  expect(api.select).not.toHaveBeenCalled();
  expect(store.tabs[doc.id]!.draft.body).toBe("unsaved");
  store.discard(doc.id);
  useExecutionStore().states[doc.id] = { executionId: crypto.randomUUID(), phase: "running", startedAt: 0,
    result: null, failure: "", section: "response", format: "raw", cancelRequested: false };
  expect(await workspaces.change(otherId)).toBe(false);
  expect(api.select).not.toHaveBeenCalled();
});
it("keeps the input and selection after duplicate-name validation fails", async () => {
  workspaces.beginCreate(); workspaces.draftName = "my workspace";
  expect(await workspaces.change()).toBe(false);
  expect(workspaces.creating).toBe(true);
  expect(workspaces.draftName).toBe("my workspace");
  expect(workspaces.needsRecovery).toBe(false);
  expect(store.transitioning).toBe(false);
  expect(workspaces.catalog?.activeId).toBe(originalId);
});
it("does not switch if outgoing session persistence fails", async () => {
  await request();
  vi.spyOn(services.get(originalId)!, "saveSession").mockRejectedValue(new DataError("DATABASE_ERROR", "Cannot save"));
  workspaces.beginCreate(); workspaces.draftName = "Shopping";
  expect(await workspaces.change()).toBe(false);
  expect(api.create).not.toHaveBeenCalled();
  expect(store.tabIds).toHaveLength(1);
  expect(store.transitioning).toBe(false);
});
it("freezes outgoing writes after a lost switch response, then recovers authoritative state", async () => {
  await request();
  const create = api.create;
  vi.spyOn(api, "create").mockImplementationOnce(async name => {
    await create(name);
    throw new DataError("IPC_ERROR", "Response lost");
  });
  workspaces.beginCreate(); workspaces.draftName = "Shopping";
  expect(await workspaces.change()).toBe(false);
  expect(workspaces.needsRecovery).toBe(true);
  expect(store.transitioning).toBe(true);
  expect(await store.persistSession()).toBe(false);
  await expect(store.createCollection("Wrong workspace")).rejects.toThrow("Wait for the workspace change");
  await workspaces.recover();
  expect(workspaces.needsRecovery).toBe(false);
  expect(store.transitioning).toBe(false);
  expect(workspaces.activeName).toBe("Shopping");
  expect(store.data.collections).toEqual([]);
  expect(store.tabIds).toEqual([]);
});
it("selecting the current workspace is a silent no-op", async () => {
  expect(await workspaces.change(originalId)).toBe(true);
  expect(api.select).not.toHaveBeenCalled();
});
it("rechecks dirty drafts after flushing an outgoing session", async () => {
  const doc = await request();
  const service = services.get(originalId)!;
  const save = service.saveSession;
  vi.spyOn(service, "saveSession").mockImplementationOnce(async value => {
    store.tabs[doc.id]!.draft.body = "Changed during flush";
    return save(value);
  });
  workspaces.beginCreate(); workspaces.draftName = "Shopping";
  expect(await workspaces.change()).toBe(false);
  expect(api.create).not.toHaveBeenCalled();
  expect(store.tabs[doc.id]!.draft.body).toBe("Changed during flush");
  expect(store.transitioning).toBe(false);
});
it("sets a default without switching active data, then protects it from deletion", async () => {
  workspaces.beginCreate(); workspaces.draftName = "Shopping";
  await workspaces.change();
  const second = workspaces.catalog!.activeId;
  await workspaces.change(originalId);
  expect(await workspaces.manage("default", second)).toBe(true);
  expect(workspaces.catalog?.defaultId).toBe(second);
  expect(workspaces.catalog?.activeId).toBe(originalId);
  workspaces.deletingId = second;
  expect(await workspaces.manage("delete", second)).toBe(false);
  expect(api.remove).not.toHaveBeenCalled();
});
it("deleting the active non-default workspace opens default and preserves its tabs", async () => {
  const doc = await request();
  workspaces.beginCreate(); workspaces.draftName = "Shopping";
  await workspaces.change();
  const second = workspaces.catalog!.activeId;
  workspaces.managing = true;
  workspaces.deletingId = second;
  expect(await workspaces.manage("delete", second)).toBe(true);
  expect(workspaces.catalog?.activeId).toBe(originalId);
  expect(store.tabIds).toEqual([doc.id]);
  expect(workspaces.managing).toBe(true);
  expect(workspaces.deletingId).toBeNull();
});
it("removing an inactive workspace does not rebuild the current tabs", async () => {
  const doc = await request();
  workspaces.beginCreate(); workspaces.draftName = "Shopping";
  await workspaces.change();
  const second = workspaces.catalog!.activeId;
  await workspaces.change(originalId);
  const tab = store.tabs[doc.id];
  workspaces.deletingId = second;
  expect(await workspaces.manage("delete", second)).toBe(true);
  expect(store.tabs[doc.id]).toBe(tab);
  expect(workspaces.catalog?.workspaces).toHaveLength(1);
});
it("returns to management when creation from management is cancelled", () => {
  workspaces.managing = true;
  workspaces.beginCreate();
  expect(workspaces.creating).toBe(true);
  expect(workspaces.managing).toBe(false);
  workspaces.cancelCreate();
  expect(workspaces.managing).toBe(true);
  expect(api.create).not.toHaveBeenCalled();
});
