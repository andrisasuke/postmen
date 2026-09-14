import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { EditorState } from "@codemirror/state";
import { createMemoryApi } from "../fixtures/memory-api";
import { clone, newRow } from "../types/data";
import type { DataApi, RequestDoc } from "../types/data";
import { DataError } from "../services/data";
import { useSettingsStore } from "./settings";
import { useWorkspaceStore } from "./workspace";
import { useNotificationsStore } from "./notifications";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("M2 workspace drafts and persistence", () => {
  let pinia: ReturnType<typeof createPinia>;
  let api: DataApi;
  let store: ReturnType<typeof useWorkspaceStore>;
  beforeEach(async () => {
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    api = createMemoryApi();
    store = useWorkspaceStore();
    await store.initialize(api);
  });
  afterEach(() => {
    disposePinia(pinia);
    vi.unstubAllGlobals();
  });
  async function pair() {
    const c = await store.createCollection("Workspace 日本語");
    const parent = { collectionId: c.id, parentId: null };
    return {
      c,
      parent,
      a: await store.createRequest(parent, "Alpha"),
      b: await store.createRequest(parent, "Beta"),
    };
  }

  it("starts empty and never needs a legacy account", () => {
    expect(store.ready).toBe(true);
    expect(store.data.collections).toEqual([]);
    expect(store.tabIds).toEqual([]);
  });
  it("merges an imported collection without resetting unrelated drafts or tabs", async () => {
    const { a, c } = await pair();
    store.tabs[a.id]!.draft.url = "https://example.test/unsaved";
    const imported = await api.createCollection("Imported");
    const request = await api.createRequest({ collectionId: imported.id, folderId: null, name: "New request" });
    store.applyImportedCollection({ status: "imported", collectionId: imported.id, replacedId: null, workspace: await api.loadWorkspace() });
    expect(store.dirty(a.id)).toBe(true);
    expect(store.tabIds).toContain(a.id);
    expect(store.data.collections.some(item => item.id === c.id)).toBe(true);
    expect(store.data.requests.some(item => item.id === request.id)).toBe(true);
    expect(store.selectedCollectionId).toBe(imported.id);
    expect(store.activeId).toBeNull();
  });
  it("closes only clean tabs belonging to an overwritten collection", async () => {
    const { a, b, c } = await pair();
    const other = await store.createCollection("Other");
    const otherRequest = await store.createRequest({ collectionId: other.id, parentId: null }, "Keep");
    store.tabs[otherRequest.id]!.draft.body = "Unsaved";
    const workspace = clone(store.data);
    workspace.requests = workspace.requests.filter(request => request.collectionId !== c.id);
    store.applyImportedCollection({ status: "imported", collectionId: c.id, replacedId: c.id, workspace });
    expect(store.tabs[a.id]).toBeUndefined(); expect(store.tabs[b.id]).toBeUndefined();
    expect(store.tabs[otherRequest.id]!.draft.body).toBe("Unsaved");
    expect(store.tabIds).toEqual([otherRequest.id]);
  });
  it("notifies only after save commits, preserving edits made during the save", async () => {
    const { a } = await pair();
    const notifications = useNotificationsStore(); notifications.clear();
    const pending = deferred<RequestDoc>();
    vi.spyOn(api, "saveRequest").mockReturnValueOnce(pending.promise);
    store.tabs[a.id]!.draft.body = "First edit";
    const snapshot = clone(store.tabs[a.id]!.draft);
    const saving = store.save(a.id);
    expect(notifications.items).toEqual([]);
    expect(await store.save(a.id)).toBe(false);
    store.tabs[a.id]!.draft.url = "https://example.test/new-edit";
    pending.resolve({ ...snapshot, revision: snapshot.revision + 1 });
    expect(await saving).toBe(false);
    expect(notifications.items.map(item => item.message)).toEqual(["Request saved. Newer edits are still unsaved."]);
    expect(store.dirty(a.id)).toBe(true);
  });
  it("reports one clone success rather than both clone and nested create", async () => {
    const { a } = await pair();
    const notifications = useNotificationsStore(); notifications.clear();
    await store.cloneRequest(a.id, "Copy");
    expect(notifications.items.map(item => item.message)).toEqual(["Request cloned successfully"]);
  });
  it("skips unchanged saves without writing, incrementing revision or emitting a toast", async () => {
    const { a } = await pair();
    const notifications = useNotificationsStore(); notifications.clear();
    const write = vi.spyOn(api, "saveRequest");
    const tab = store.tabs[a.id]!;
    expect(await store.save(a.id)).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(notifications.items).toEqual([]);
    tab.draft.body = "Changed";
    expect(await store.save(a.id)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const saved = clone(tab.saved);
    notifications.clear();
    expect(await store.save(a.id)).toBe(true);
    expect(await store.save(a.id)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(tab.saved).toEqual(saved);
    expect(tab.saving).toBe(false);
    expect(notifications.items).toEqual([]);
    tab.draft.body = "Temporary edit";
    tab.draft.body = saved.body;
    expect(await store.save(a.id)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(notifications.items).toEqual([]);
  });
  it("reports create/save failures once, keeps drafts and excludes error details from toasts", async () => {
    const { a, parent } = await pair();
    const notifications = useNotificationsStore(); notifications.clear();
    const failure = new Error("Private error details");
    vi.spyOn(api, "createRequest").mockRejectedValueOnce(failure);
    await expect(store.createRequest(parent, "Failed")).rejects.toBe(failure);
    expect(notifications.items.map(item => item.message)).toEqual(["Failed to create request"]);
    notifications.clear();
    store.tabs[a.id]!.draft.body = "keep this draft";
    vi.spyOn(api, "saveRequest").mockRejectedValueOnce(failure);
    await expect(store.save(a.id)).rejects.toBe(failure);
    expect(notifications.items.map(item => item.message)).toEqual(["Failed to save request"]);
    expect(store.tabs[a.id]!.draft.body).toBe("keep this draft");
    expect(store.tabs[a.id]!.saving).toBe(false);
  });
  it("keeps automatic session writes and no-op moves silent", async () => {
    const { a } = await pair();
    const notifications = useNotificationsStore(); notifications.clear();
    await store.persistSession();
    await store.moveSibling({ kind: "request", id: a.id }, -1);
    expect(notifications.items).toEqual([]);
  });
  it("skips unchanged environment variables and retries changed content after a failed save", async () => {
    const { c } = await pair();
    const env = await store.saveEnvironment({ id: null, collectionId: c.id, name: "Local", revision: null,
      variables: [{ ...newRow(), name: "api_url", value: "https://example.test" }] });
    const notifications = useNotificationsStore(); notifications.clear();
    const write = vi.spyOn(api, "saveEnvironment");
    expect(await store.saveEnvironment(clone(env))).toEqual(env);
    expect(write).not.toHaveBeenCalled();
    expect(notifications.items).toEqual([]);
    const changed = clone(env); changed.variables[0]!.value = "https://example.test/new";
    write.mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(store.saveEnvironment(changed)).rejects.toThrow("Disk unavailable");
    expect(store.data.environments.find(item => item.id === env.id)).toEqual(env);
    const saved = await store.saveEnvironment(changed);
    expect(write).toHaveBeenCalledTimes(2);
    expect(saved.revision).toBe(env.revision + 1);
    notifications.clear();
    // Object key ordering and revision metadata are not editable changes.
    const row = saved.variables[0]!;
    const identical = { ...saved, variables: [{ description: row.description, value: row.value, name: row.name, enabled: row.enabled, id: row.id }] };
    expect(await store.saveEnvironment(identical)).toEqual(saved);
    expect(write).toHaveBeenCalledTimes(2);
    expect(notifications.items).toEqual([]);
  });
  it("skips unchanged rename, destination, order and environment selection", async () => {
    const { a, c, parent } = await pair();
    const folder = await store.createFolder(parent, "Folder");
    const env = await store.saveEnvironment({ id: null, collectionId: c.id, name: "Local", revision: null, variables: [] });
    await store.selectEnvironment(c.id, env.id);
    const notifications = useNotificationsStore(); notifications.clear();
    const writes = [vi.spyOn(api, "renameCollection"), vi.spyOn(api, "updateFolder"), vi.spyOn(api, "saveRequest"), vi.spyOn(api, "reorderItems"), vi.spyOn(api, "selectEnvironment")];
    const request = { kind: "request" as const, id: a.id };
    await store.rename(request, a.name);
    await store.rename({ kind: "collection", id: c.id }, c.name);
    await store.rename({ kind: "folder", id: folder.id }, folder.name);
    await store.moveToFolder(request, a.folderId);
    await store.moveToFolder({ kind: "folder", id: folder.id }, folder.parentId);
    await store.reorderSiblings(request, store.siblings(request));
    await store.selectEnvironment(c.id, env.id);
    await store.selectEnvironment(null, null);
    writes.forEach(write => expect(write).not.toHaveBeenCalled());
    expect(notifications.items).toEqual([]);
  });
  it("coalesces identical queued session saves and retries unchanged payloads after failure", async () => {
    await pair();
    const write = vi.spyOn(api, "saveSession");
    await Promise.all([store.persistSession(), store.persistSession()]);
    expect(write).toHaveBeenCalledTimes(1);
    await store.persistSession();
    expect(write).toHaveBeenCalledTimes(1);
    store.activate(null);
    write.mockRejectedValueOnce(new Error("Disk busy"));
    expect(await store.persistSession()).toBe(false);
    expect(await store.persistSession()).toBe(true);
    expect(write).toHaveBeenCalledTimes(3);
    await store.persistSession();
    expect(write).toHaveBeenCalledTimes(3);
  });
  it("ignores native session map key ordering when detecting repeated saves", async () => {
    await pair();
    const saveSession = api.saveSession.bind(api);
    const write = vi.spyOn(api, "saveSession").mockImplementation(async input => {
      const saved = await saveSession(input);
      saved.views = Object.fromEntries(Object.entries(saved.views).reverse());
      return saved;
    });
    await store.persistSession();
    await store.persistSession();
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("keeps independent drafts, tabs, sections, editor states and pane sizes", async () => {
    const { a, b } = await pair();
    const settings = useSettingsStore();
    store.activate(a.id);
    store.tabs[a.id]!.draft.body = '{"one":1}';
    store.updateView(a.id, { section: "body" });
    settings.preferences.requestWidth = 460;
    const state = EditorState.create({ doc: "independent" });
    store.cacheEditor(a.id, state);
    store.activate(b.id);
    expect(store.tabs[b.id]!.draft.body).toBe("");
    expect(settings.preferences.requestWidth).not.toBe(460);
    store.activate(a.id);
    expect(settings.preferences.requestWidth).toBe(460);
    expect(store.active?.view.section).toBe("body");
    expect(store.active?.editorState).toBe(state);
    expect(store.dirtyIds).toEqual([a.id]);
  });
  it("clones an open draft into the same folder without saving or changing the original", async () => {
    const { c } = await pair();
    const folder = await store.createFolder({ collectionId: c.id, parentId: null }, "Nested");
    const original = await store.createRequest({ collectionId: c.id, parentId: folder.id }, "Source");
    const draft = store.tabs[original.id]!.draft;
    draft.method = "POST";
    draft.url = "<<api_url>>/users";
    draft.bodyKind = "json";
    draft.body = '{"name":"日本語"}';
    draft.params = [{ ...newRow(), name: "q", value: "<<query>>", description: "query" }];
    draft.headers = [{ ...newRow(), name: "X-Repeat", value: "one" }, { ...newRow(), name: "X-Repeat", value: "two", enabled: false }];
    draft.formData = [{ ...newRow(), name: "file", kind: "file", attachmentId: crypto.randomUUID() }];
    const before = clone(draft);
    const save = vi.spyOn(api, "saveRequest");
    const copy = await store.cloneRequest(original.id, "Source - Copy");
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("Source - Copy");
    expect(copy.collectionId).toBe(c.id);
    expect(copy.folderId).toBe(folder.id);
    expect(copy.revision).toBe(1);
    expect(copy.method).toBe("POST");
    expect(copy.url).toBe(before.url);
    expect(copy.body).toBe(before.body);
    for (const table of ["params", "headers", "formData"] as const) {
      copy[table].forEach((row, index) => {
        expect(row.id).not.toBe(before[table][index]!.id);
        expect({ ...row, id: "ignored" }).toEqual({ ...before[table][index], id: "ignored" });
      });
    }
    expect(save).not.toHaveBeenCalled();
    expect(store.tabs[original.id]!.draft).toEqual(before);
    expect((await api.getRequest(original.id)).url).toBe("");
    expect(store.dirty(original.id)).toBe(true);
    expect(store.dirty(copy.id)).toBe(false);
    expect(store.activeId).toBe(copy.id);
    store.tabs[copy.id]!.draft.headers[0]!.value = "independent";
    expect(store.tabs[original.id]!.draft.headers[0]!.value).toBe("one");
  });
  it("loads closed requests before cloning and keeps placeholders unresolved", async () => {
    const { a } = await pair();
    store.tabs[a.id]!.draft.url = "<<api_url>>/users";
    await store.save(a.id);
    store.closeClean(a.id);
    const get = vi.spyOn(api, "getRequest");
    const copy = await store.cloneRequest(a.id, "Saved copy");
    expect(get).toHaveBeenCalledWith(a.id);
    expect(copy.url).toBe("<<api_url>>/users");
    expect(copy.folderId).toBeNull();
    expect(store.tabs[a.id]).toBeUndefined();
  });
  it("failed clone leaves the source and tab list unchanged", async () => {
    const { a } = await pair();
    const before = clone(store.tabs[a.id]!.draft);
    const ids = [...store.tabIds];
    vi.spyOn(api, "createRequest").mockRejectedValueOnce(new Error("Disk full"));
    await expect(store.cloneRequest(a.id, "Failed copy")).rejects.toThrow("Disk full");
    expect(store.tabIds).toEqual(ids);
    expect(store.tabs[a.id]!.draft).toEqual(before);
    expect(store.data.requests).toHaveLength(2);
  });
  it("deduplicates simultaneous opens", async () => {
    const { a } = await pair();
    store.closeClean(a.id);
    const get = vi.spyOn(api, "getRequest");
    await Promise.all([store.open(a.id), store.open(a.id)]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(store.tabIds.filter((id) => id === a.id)).toHaveLength(1);
  });
  it("refuses dirty close; discard restores the saved document and clears undo", async () => {
    const { a } = await pair();
    store.tabs[a.id]!.draft.url = "/draft";
    expect(store.closeClean(a.id)).toBe(false);
    store.cacheEditor(a.id, EditorState.create());
    expect(store.discard(a.id)).toBe(true);
    expect(store.tabs[a.id]!.editorState).toBeNull();
    expect(store.closeClean(a.id)).toBe(true);
  });
  it("round-trips repeated headers, disabled rows, unicode and invalid JSON verbatim", async () => {
    const { a } = await pair();
    const tab = store.tabs[a.id]!;
    tab.draft.headers = [
      { ...newRow(), name: "X-Repeat", value: "日本語" },
      { ...newRow(), name: "X-Repeat", value: "second", enabled: false },
    ];
    tab.draft.bodyKind = "json";
    tab.draft.body = "{broken";
    expect(await store.save(a.id)).toBe(true);
    store.closeClean(a.id);
    await store.open(a.id);
    expect(store.active?.draft.headers).toEqual(tab.draft.headers);
    expect(store.active?.draft.body).toBe("{broken");
    expect(store.active?.view.section).toBe("body");
  });
  it("keeps edits made during a save and advances their revision", async () => {
    const { a } = await pair();
    const tab = store.tabs[a.id]!;
    tab.draft.url = "/first";
    const pending = deferred<RequestDoc>();
    const save = api.saveRequest.bind(api);
    vi.spyOn(api, "saveRequest").mockImplementationOnce(() => pending.promise);
    const operation = store.save(a.id);
    expect(tab.saving).toBe(true);
    expect(store.closeClean(a.id)).toBe(false);
    const snapshot = clone(tab.draft);
    tab.draft.url = "/second";
    pending.resolve(await save(snapshot));
    expect(await operation).toBe(false);
    expect(tab.saved.url).toBe("/first");
    expect(tab.draft.url).toBe("/second");
    expect(tab.draft.revision).toBe(tab.saved.revision);
    expect(await store.save(a.id)).toBe(true);
  });
  it("keeps draft and saved snapshot after disk/IPC failure", async () => {
    const { a } = await pair();
    const tab = store.tabs[a.id]!;
    tab.draft.url = "/keep-me";
    vi.spyOn(api, "saveRequest").mockRejectedValueOnce(
      new DataError("DATABASE_ERROR", "Storage unavailable"),
    );
    await expect(store.save(a.id)).rejects.toThrow("Storage unavailable");
    expect(tab.saving).toBe(false);
    expect(tab.saved.url).toBe("");
    expect(tab.draft.url).toBe("/keep-me");
    expect(store.error).toBe("Storage unavailable");
  });
  it("does not overwrite a newer saved revision", async () => {
    const { a } = await pair();
    await api.saveRequest({ ...a, url: "/external" });
    store.tabs[a.id]!.draft.url = "/local";
    await expect(store.save(a.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.tabs[a.id]!.draft.url).toBe("/local");
    await store.reloadSaved(a.id);
    expect(store.tabs[a.id]!.draft.url).toBe("/external");
  });
  it("preserves a concurrent edit during rename", async () => {
    const { a } = await pair();
    const pending = deferred<RequestDoc>();
    const save = api.saveRequest.bind(api);
    let submitted!: RequestDoc;
    vi.spyOn(api, "saveRequest").mockImplementationOnce((input) => {
      submitted = clone(input);
      return pending.promise;
    });
    const operation = store.rename({ kind: "request", id: a.id }, "Renamed");
    store.tabs[a.id]!.draft.body = "keep during rename";
    pending.resolve(await save(submitted));
    await operation;
    expect(store.tabs[a.id]!.draft.name).toBe("Renamed");
    expect(store.tabs[a.id]!.draft.body).toBe("keep during rename");
    expect(store.dirty(a.id)).toBe(true);
  });
  it("does not replace a draft edited during explicit reload", async () => {
    const { a } = await pair();
    const pending = deferred<RequestDoc>();
    vi.spyOn(api, "getRequest").mockReturnValueOnce(pending.promise);
    const operation = store.reloadSaved(a.id);
    store.tabs[a.id]!.draft.body = "keep";
    pending.resolve(a);
    await expect(operation).rejects.toMatchObject({ code: "UNSAVED_CHANGES" });
    expect(store.tabs[a.id]!.draft.body).toBe("keep");
  });
  it("restores saved tab order, active tab and editor view without persisting drafts", async () => {
    const { a, b } = await pair();
    store.reorderTabs([b.id, a.id]);
    store.activate(a.id);
    store.updateView(a.id, {
      section: "headers",
      selection: { anchor: 3, head: 3 },
      scroll: { top: 100, left: 0 },
    });
    store.tabs[a.id]!.draft.url = "/unsaved";
    await store.persistSession();
    store.$dispose();
    const other = createPinia();
    setActivePinia(other);
    const restored = useWorkspaceStore();
    await restored.initialize(api);
    expect(restored.tabIds).toEqual([b.id, a.id]);
    expect(restored.activeId).toBe(a.id);
    expect(restored.active?.view.section).toBe("headers");
    expect(restored.active?.draft.url).toBe("");
    disposePinia(other);
  });
  it("serializes session writes and recovers after a failure", async () => {
    const { a, b } = await pair();
    const pending = deferred<Awaited<ReturnType<DataApi["saveSession"]>>>();
    const save = api.saveSession.bind(api);
    const spy = vi
      .spyOn(api, "saveSession")
      .mockReturnValueOnce(pending.promise);
    store.activate(a.id);
    const first = store.persistSession();
    await Promise.resolve();
    store.activate(b.id);
    const second = store.persistSession();
    expect(spy).toHaveBeenCalledTimes(1);
    pending.reject(new Error("disk busy"));
    await first;
    await second;
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await api.loadWorkspace()).session.activeId).toBe(b.id);
    expect(store.sessionError).toBe("");
    await save({ tabIds: [], activeId: null, views: {} });
  });
  it("deletes a folder cascade and its dirty tabs, leaving other requests", async () => {
    const { parent, b } = await pair();
    const folder = await store.createFolder(parent, "Folder");
    const nested = await store.createFolder(
      { ...parent, parentId: folder.id },
      "Nested",
    );
    const request = await store.createRequest(
      { ...parent, parentId: nested.id },
      "Child",
    );
    store.tabs[request.id]!.draft.body = "unsaved";
    await store.remove({ kind: "folder", id: folder.id });
    expect(store.tabs[request.id]).toBeUndefined();
    expect(store.data.folders).toHaveLength(0);
    expect(store.data.requests.some((r) => r.id === b.id)).toBe(true);
  });
  it("rejects deletion during an in-flight save", async () => {
    const { a, c } = await pair();
    store.tabs[a.id]!.saving = true;
    await expect(
      store.remove({ kind: "collection", id: c.id }),
    ).rejects.toMatchObject({ code: "BUSY" });
    expect(store.data.collections).toHaveLength(1);
  });
  it("does not resurrect a request deleted while opening", async () => {
    const { a } = await pair();
    store.closeClean(a.id);
    const pending = deferred<RequestDoc>();
    vi.spyOn(api, "getRequest").mockReturnValueOnce(pending.promise);
    const operation = store.open(a.id);
    await store.remove({ kind: "request", id: a.id });
    pending.resolve(a);
    await expect(operation).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(store.tabs[a.id]).toBeUndefined();
  });
  it("moves mixed siblings and a clean request into a folder", async () => {
    const { a, b, parent } = await pair();
    const folder = await store.createFolder(parent, "Folder");
    await store.moveSibling({ kind: "folder", id: folder.id }, -1);
    expect(
      store.siblings({ kind: "request", id: a.id }).map((x) => x.id),
    ).toEqual([a.id, folder.id, b.id]);
    await store.moveToFolder({ kind: "request", id: a.id }, folder.id);
    expect(store.tabs[a.id]!.draft.folderId).toBe(folder.id);
    expect(store.dirty(a.id)).toBe(false);
  });
  it("deleting a selected environment clears selection, retaining request templates and draft bodies", async () => {
    const { a } = await pair();
    const env = await store.saveEnvironment({
      id: null,
      collectionId: a.collectionId,
      name: "Local",
      variables: [],
      revision: null,
    });
    await store.selectEnvironment(a.collectionId, env.id);
    store.tabs[a.id]!.draft.url = "<<api_url>>/users";
    await store.save(a.id);
    store.tabs[a.id]!.draft.body = "draft stays";
    await store.deleteEnvironment(env.id);
    expect(store.selectedEnvironment(a.collectionId)).toBeUndefined();
    expect(store.tabs[a.id]!.saved.url).toBe("<<api_url>>/users");
    expect(store.tabs[a.id]!.draft.url).toBe("<<api_url>>/users");
    expect(store.tabs[a.id]!.draft.body).toBe("draft stays");
    expect(store.dirty(a.id)).toBe(true);
  });
});
