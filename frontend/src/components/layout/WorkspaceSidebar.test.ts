import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import WorkspaceSidebar from "./WorkspaceSidebar.vue";
import { useWorkspaceStore } from "../../stores/workspace";
import { useSettingsStore } from "../../stores/settings";
import { createMemoryApi } from "../../fixtures/memory-api";

let pinia: ReturnType<typeof createPinia>;
let wrapper: VueWrapper;
let api: ReturnType<typeof createMemoryApi>;
const row = (name: string) => wrapper.findAll(".data-tree-row").find(node => node.get(".tree-name").text() === name)!;
const menuItem = (label: string) => document.querySelector<HTMLButtonElement>(`[role="menuitem"][aria-label="${label}"]`);
async function drag(source: string, target: string, clientY = 50) {
  const destination = row(target);
  vi.spyOn(destination.element, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect);
  await row(source).trigger("dragstart");
  await destination.trigger("dragover", { clientY });
  await flushPromises();
  await destination.trigger("drop", { clientY });
  await flushPromises();
}
async function openMenu(name: string) {
  await wrapper.get(`button[aria-label="Actions for ${name}"]`).trigger("click");
  await flushPromises();
}
async function action(name: string, label: string) {
  await openMenu(name);
  expect(menuItem(label)).not.toBeNull();
  menuItem(label)!.click();
  await flushPromises();
}
beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  pinia = createPinia(); setActivePinia(pinia);
  const store = useWorkspaceStore();
  api = createMemoryApi();
  await store.initialize(api);
  const collection = await store.createCollection("Collection");
  const folder = await store.createFolder({ collectionId: collection.id, parentId: null }, "Folder");
  const child = await store.createFolder({ collectionId: collection.id, parentId: folder.id }, "Subfolder");
  await store.createRequest({ collectionId: collection.id, parentId: child.id }, "Nested request");
  await store.createRequest({ collectionId: collection.id, parentId: null }, "Root request");
  wrapper = mount(WorkspaceSidebar, { attachTo: document.body });
  await flushPromises();
});
afterEach(() => { wrapper.unmount(); disposePinia(pinia); document.body.replaceChildren(); vi.unstubAllGlobals(); });

async function emptyCollections() {
  const store = useWorkspaceStore();
  store.data.collections = [];
  store.data.folders = [];
  store.data.requests = [];
  await flushPromises();
}
it("offers Create and Import when no collections exist", async () => {
  await emptyCollections();
  const empty = wrapper.get(".sidebar-empty");
  expect(empty.text()).toContain("No collections found.");
  expect(empty.findAll("button").map(button => button.text())).toEqual(["Create", "Import"]);
  await empty.get("button:last-of-type").trigger("click");
  expect(wrapper.emitted("import")).toEqual([[]]);
  await empty.get("button:first-of-type").trigger("click");
  expect(wrapper.find('input[aria-label="Item name"]').exists()).toBe(true);
  expect(wrapper.find('button[aria-label="Confirm create collection"]').exists()).toBe(true);
});
it("keeps empty collection actions unavailable before the workspace is ready", async () => {
  await emptyCollections();
  useWorkspaceStore().ready = false;
  await flushPromises();
  expect(wrapper.get(".sidebar-empty").findAll("button")).toHaveLength(0);
  expect(wrapper.get(".sidebar-empty").text()).toContain("Open the desktop app");
});
it("does not show Create/Import empty-state links for populated or filtered collections", async () => {
  expect(wrapper.find(".sidebar-empty-actions").exists()).toBe(false);
  await wrapper.get('button[aria-label="Search collections"]').trigger("click");
  await wrapper.get('input[aria-label="Search collections"]').setValue("no-such-collection");
  expect(wrapper.get(".sidebar-empty").text()).toBe("No matching items.");
  expect(wrapper.find(".sidebar-empty-actions").exists()).toBe(false);
});

it("offers the correct Expand/Collapse action for collections, folders and subfolders", async () => {
  for (const name of ["Subfolder", "Folder", "Collection"]) {
    expect(row(name).attributes("aria-expanded")).toBe("true");
    await action(name, "Collapse");
    expect(row(name).attributes("aria-expanded")).toBe("false");
    expect(row("Nested request")).toBeUndefined();
    await openMenu(name);
    expect(menuItem("Collapse")).toBeNull();
    menuItem("Expand")!.click(); await flushPromises();
    expect(row(name).attributes("aria-expanded")).toBe("true");
    expect(row("Nested request")).toBeDefined();
  }
});
it("keeps child expansion state when collapsing and reopening its parent", async () => {
  await action("Subfolder", "Collapse");
  await action("Collection", "Collapse");
  await action("Collection", "Expand");
  expect(row("Folder").attributes("aria-expanded")).toBe("true");
  expect(row("Subfolder").attributes("aria-expanded")).toBe("false");
  expect(row("Nested request")).toBeUndefined();
  expect(row("Root request")).toBeDefined();
});
it("restores collapsed parents and descendants after a fresh store/sidebar startup", async () => {
  await action("Subfolder", "Collapse");
  await action("Collection", "Collapse");
  await useWorkspaceStore().persistSession();
  expect(useSettingsStore().persistPreferences()).toBe(true);
  wrapper.unmount(); disposePinia(pinia);
  pinia = createPinia(); setActivePinia(pinia);
  await useWorkspaceStore().initialize(api);
  wrapper = mount(WorkspaceSidebar, { attachTo: document.body });
  await flushPromises();
  expect(row("Collection").attributes("aria-expanded")).toBe("false");
  expect(row("Folder")).toBeUndefined();
  await action("Collection", "Expand");
  expect(row("Folder").attributes("aria-expanded")).toBe("true");
  expect(row("Subfolder").attributes("aria-expanded")).toBe("false");
  expect(row("Nested request")).toBeUndefined();
});
it("keeps search-only expansion overrides out of persistent preferences", async () => {
  await action("Folder", "Collapse");
  const saved = JSON.stringify(useSettingsStore().preferences.treeExpanded);
  await wrapper.get('button[aria-label="Search collections"]').trigger("click");
  await wrapper.get('input[aria-label="Search collections"]').setValue("Nested request");
  await action("Folder", "Collapse");
  await action("Folder", "Expand");
  expect(JSON.stringify(useSettingsStore().preferences.treeExpanded)).toBe(saved);
  wrapper.unmount();
  wrapper = mount(WorkspaceSidebar, { attachTo: document.body });
  await flushPromises();
  expect(row("Folder").attributes("aria-expanded")).toBe("false");
});
it("does not refocus the ellipsis after pointer collapse/expand at any folder depth", async () => {
  for (const name of ["Subfolder", "Folder", "Collection"]) {
    const trigger = wrapper.get(`button[aria-label="Actions for ${name}"]`);
    for (const label of ["Collapse", "Expand"]) {
      trigger.element.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      await flushPromises();
      menuItem(label)!.focus();
      menuItem(label)!.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      await flushPromises();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).not.toBe(trigger.element);
      expect(trigger.attributes("aria-expanded")).toBe("false");
      expect(row(name).attributes("aria-expanded")).toBe(label === "Expand" ? "true" : "false");
    }
  }
});
it("restores ellipsis focus after keyboard selection and Escape", async () => {
  const trigger = wrapper.get('button[aria-label="Actions for Folder"]');
  await trigger.trigger("keydown", { key: "ArrowDown" });
  await flushPromises();
  menuItem("Collapse")!.focus();
  menuItem("Collapse")!.click();
  await flushPromises();
  expect(document.activeElement).toBe(trigger.element);
  trigger.element.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  await flushPromises();
  document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flushPromises();
  expect(document.activeElement).toBe(trigger.element);
});
it("uses the same expansion state for row clicks, right-click and keyboard menus", async () => {
  await row("Folder").trigger("click");
  await row("Folder").trigger("contextmenu", { clientX: 40, clientY: 80 });
  await flushPromises();
  expect(menuItem("Expand")).not.toBeNull();
  menuItem("Expand")!.click(); await flushPromises();
  await row("Folder").trigger("keydown", { key: "F10", shiftKey: true });
  await flushPromises();
  expect(menuItem("Collapse")).not.toBeNull();
});
it("lets search results collapse while preserving the normal tree state", async () => {
  await action("Folder", "Collapse");
  await wrapper.get('button[aria-label="Search collections"]').trigger("click");
  const input = wrapper.get('input[aria-label="Search collections"]');
  await input.setValue("Nested request");
  expect(row("Folder").attributes("aria-expanded")).toBe("true");
  expect(row("Nested request")).toBeDefined();
  await action("Folder", "Collapse");
  expect(row("Nested request")).toBeUndefined();
  await action("Folder", "Expand");
  expect(row("Nested request")).toBeDefined();
  await input.setValue("");
  expect(row("Folder").attributes("aria-expanded")).toBe("false");
  expect(row("Nested request")).toBeUndefined();
});
it("does not offer expansion actions for requests or persist a data mutation", async () => {
  const store = useWorkspaceStore();
  const before = JSON.stringify(store.data);
  await openMenu("Nested request");
  expect(menuItem("Expand")).toBeNull(); expect(menuItem("Collapse")).toBeNull();
  document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await action("Collection", "Collapse");
  expect(JSON.stringify(store.data)).toBe(before);
  expect(wrapper.emitted("open")).toBeUndefined();
});
it("moves a request dropped anywhere on a folder row into that folder", async () => {
  const store = useWorkspaceStore();
  const folderId = store.data.folders.find(folder => folder.name === "Folder")!.id;
  const subfolderId = store.data.folders.find(folder => folder.name === "Subfolder")!.id;
  const collectionId = store.data.folders.find(folder => folder.id === folderId)!.collectionId;
  for (const [name, clientY] of [["Top edge", 5], ["Middle", 50], ["Bottom edge", 95]] as const) {
    const request = await store.createRequest({ collectionId, parentId: null }, name);
    await flushPromises();
    await drag(name, "Folder", clientY);
    expect(store.data.requests.find(value => value.id === request.id)?.folderId).toBe(folderId);
  }
  expect(store.siblings({ kind: "folder", id: subfolderId }).map(item => item.kind)).toEqual([
    "folder", "request", "request", "request",
  ]);
});
it("moves a request into a nested folder, appending after its existing child", async () => {
  const store = useWorkspaceStore();
  const subfolderId = store.data.folders.find(folder => folder.name === "Subfolder")!.id;
  const nestedRequestId = store.data.requests.find(request => request.name === "Nested request")!.id;
  const rootRequestId = store.data.requests.find(request => request.name === "Root request")!.id;
  await action("Subfolder", "Collapse");
  expect(row("Subfolder").attributes("aria-expanded")).toBe("false");
  await drag("Root request", "Subfolder");
  expect(store.data.requests.find(request => request.id === rootRequestId)?.folderId).toBe(subfolderId);
  expect(store.siblings({ kind: "request", id: nestedRequestId })).toEqual([
    { kind: "request", id: nestedRequestId },
    { kind: "request", id: rootRequestId },
  ]);
  expect(row("Subfolder").attributes("aria-expanded")).toBe("true");
});
it("reorders siblings from the top and bottom drop zones", async () => {
  const store = useWorkspaceStore();
  const rootRequestId = store.data.requests.find(request => request.name === "Root request")!.id;
  const collectionId = store.data.requests.find(request => request.id === rootRequestId)!.collectionId;
  const other = await store.createRequest({ collectionId, parentId: null }, "Other root request");
  await flushPromises();
  vi.spyOn(row("Other root request").element, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect);
  await row("Root request").trigger("dragstart");
  await row("Other root request").trigger("dragover", { clientY: 5 });
  expect(row("Other root request").classes()).toContain("drop-before");
  expect(row("Other root request").classes()).not.toContain("outward-drop-target");
  await row("Root request").trigger("dragend");
  await drag("Root request", "Other root request", 5);
  let siblings = store.siblings({ kind: "request", id: other.id }).map(item => item.id);
  expect(siblings.indexOf(rootRequestId)).toBeLessThan(siblings.indexOf(other.id));
  await drag("Root request", "Other root request", 95);
  siblings = store.siblings({ kind: "request", id: other.id }).map(item => item.id);
  expect(siblings.indexOf(rootRequestId)).toBeGreaterThan(siblings.indexOf(other.id));
});
it("does not mutate for cross-collection or same-parent folder drops", async () => {
  const store = useWorkspaceStore();
  const other = await store.createCollection("Other collection");
  await store.createFolder({ collectionId: other.id, parentId: null }, "Other folder");
  await flushPromises();
  const before = JSON.stringify(store.data);
  await row("Root request").trigger("dragstart");
  await row("Other folder").trigger("dragover");
  expect(row("Other folder").classes()).not.toContain("folder-drop-target");
  await row("Other folder").trigger("drop");
  await flushPromises();
  await drag("Nested request", "Subfolder");
  expect(JSON.stringify(store.data)).toBe(before);
});
it("guides a dirty request to a valid folder and asks the app to confirm the move", async () => {
  const store = useWorkspaceStore();
  const nested = store.data.requests.find(request => request.name === "Nested request")!;
  const other = await store.createCollection("Other collection");
  await store.createFolder({ collectionId: other.id, parentId: null }, "Other folder");
  store.tabs[nested.id]!.draft.body = "unsaved";
  await row("Nested request").trigger("dragstart");
  for (const target of ["Root request", "Other folder", "Subfolder"]) {
    await row(target).trigger("dragover");
    expect(store.error).toBe("");
  }
  await row("Folder").trigger("dragover");
  expect(row("Folder").classes()).toContain("folder-drop-target");
  await row("Folder").trigger("drop");
  await flushPromises();
  expect(wrapper.emitted("moveRequests")?.[0]).toEqual([[nested.id], store.data.folders.find(folder => folder.name === "Folder")!.id]);
  expect(store.data.requests.find(request => request.id === nested.id)?.folderId).toBe(store.tabs[nested.id]!.saved.folderId);
});
it("moves requests outward onto ancestor folders and the collection root", async () => {
  const store = useWorkspaceStore();
  const nested = store.data.requests.find(request => request.name === "Nested request")!;
  const folder = store.data.folders.find(value => value.name === "Folder")!;
  await row("Nested request").trigger("dragstart");
  await row("Folder").trigger("dragover");
  expect(row("Folder").classes()).toContain("folder-drop-target");
  await row("Folder").trigger("drop");
  await flushPromises();
  expect(store.data.requests.find(request => request.id === nested.id)?.folderId).toBe(folder.id);
  await row("Nested request").trigger("dragstart");
  await row("Collection").trigger("dragover", { clientY: 5 });
  expect(row("Collection").classes()).toContain("folder-drop-target");
  await row("Collection").trigger("drop", { clientY: 5 });
  await flushPromises();
  expect(store.data.requests.find(request => request.id === nested.id)?.folderId).toBeNull();
});
it("moves out through visible parent-level request rows and marks the outward destination", async () => {
  const store = useWorkspaceStore();
  const folder = store.data.folders.find(value => value.name === "Folder")!;
  const subfolder = store.data.folders.find(value => value.name === "Subfolder")!;
  const nested = store.data.requests.find(request => request.name === "Nested request")!;
  const collectionId = folder.collectionId;
  const parentRequest = await store.createRequest({ collectionId, parentId: folder.id }, "Parent-level request");
  const folderRequest = await store.createRequest({ collectionId, parentId: folder.id }, "Folder request");
  await flushPromises();
  await row("Nested request").trigger("dragstart");
  await row("Parent-level request").trigger("dragover");
  expect(row("Parent-level request").classes()).toContain("drop-after");
  expect(row("Parent-level request").classes()).not.toContain("folder-drop-target");
  await row("Parent-level request").trigger("drop");
  await flushPromises();
  expect(store.data.requests.find(request => request.name === "Nested request")?.folderId).toBe(folder.id);
  expect(store.data.requests.find(request => request.id === parentRequest.id)?.folderId).toBe(folder.id);
  expect(store.siblings({ kind: "request", id: parentRequest.id }).map(item => item.id).slice(-2)).toEqual([nested.id, folderRequest.id]);

  await row("Folder request").trigger("dragstart");
  await row("Root request").trigger("dragover");
  expect(row("Root request").classes()).toContain("drop-after");
  await row("Root request").trigger("drop");
  await flushPromises();
  expect(store.data.requests.find(request => request.id === folderRequest.id)?.folderId).toBeNull();
  expect(store.siblings({ kind: "request", id: folderRequest.id }).map(item => item.id).slice(-2)).toEqual([
    store.data.requests.find(request => request.name === "Root request")!.id, folderRequest.id,
  ]);
  expect(store.data.requests.find(request => request.name === "Nested request")?.folderId).toBe(folder.id);
  expect(store.data.folders.find(value => value.id === subfolder.id)).toBeDefined();
});
it("moves a request from PRF into PO immediately before PO Target Stock", async () => {
  const store = useWorkspaceStore();
  const source = store.data.requests.find(request => request.name === "Nested request")!;
  const collectionId = source.collectionId;
  const po = await store.createFolder({ collectionId, parentId: null }, "PO");
  const earlier = await store.createRequest({ collectionId, parentId: po.id }, "PO Earlier");
  const target = await store.createRequest({ collectionId, parentId: po.id }, "PO Target Stock");
  const later = await store.createRequest({ collectionId, parentId: po.id }, "PO Later");
  await flushPromises();

  await drag("Nested request", "PO Target Stock", 5);

  expect(store.data.requests.find(request => request.id === source.id)?.folderId).toBe(po.id);
  expect(store.siblings({ kind: "request", id: target.id }).map(item => item.id)).toEqual([
    earlier.id, source.id, target.id, later.id,
  ]);
});
it("uses the dirty Save All & Move warning for outward request-row destinations", async () => {
  const store = useWorkspaceStore();
  const folder = store.data.folders.find(value => value.name === "Folder")!;
  const nested = store.data.requests.find(request => request.name === "Nested request")!;
  const parentRequest = await store.createRequest({ collectionId: folder.collectionId, parentId: folder.id }, "Parent-level request");
  store.tabs[nested.id]!.draft.body = "confirm outward move";
  await drag("Nested request", "Parent-level request");
  expect(wrapper.emitted("moveRequests")?.[0]).toEqual([[nested.id], folder.id, parentRequest.id, true]);
  expect(store.data.requests.find(request => request.id === nested.id)?.folderId).not.toBe(parentRequest.id);
});
it("sends dirty multi-selection to the collection root in tree order", async () => {
  const store = useWorkspaceStore();
  const root = store.data.requests.find(request => request.name === "Root request")!;
  const nested = store.data.requests.find(request => request.name === "Nested request")!;
  store.tabs[nested.id]!.draft.body = "requires root confirmation";
  await row("Root request").trigger("click", { metaKey: true });
  await row("Nested request").trigger("click", { ctrlKey: true });
  await drag("Nested request", "Collection", 95);
  expect(wrapper.emitted("moveRequests")?.[0]).toEqual([[nested.id, root.id], null]);
});
it("uses the same blocked folder-drop decision for dragover and drop", async () => {
  const store = useWorkspaceStore();
  const root = store.data.requests.find(request => request.name === "Root request")!;
  const folderId = store.data.folders.find(folder => folder.name === "Folder")!.id;
  store.tabs[root.id]!.draft.body = "unsaved";
  await drag("Root request", "Folder", 5);
  expect(wrapper.emitted("moveRequests")?.[0]).toEqual([[root.id], folderId]);
  await row("Root request").trigger("dragstart");
  store.tabs[root.id]!.saving = true;
  const beforeSavingFolderMove = JSON.stringify(store.data);
  await row("Folder").trigger("dragover", { clientY: 95 });
  expect(row("Folder").classes()).not.toContain("folder-drop-target");
  expect(store.error).toBe("Wait for selected request saves to finish.");
  await row("Folder").trigger("drop", { clientY: 95 });
  await flushPromises();
  expect(store.error).toBe("Wait for selected request saves to finish.");
  expect(JSON.stringify(store.data)).toBe(beforeSavingFolderMove);
  store.tabs[root.id]!.saving = false;
  store.discard(root.id);
  vi.spyOn(api, "saveAndMoveRequests").mockRejectedValueOnce(new Error("disk unavailable"));
  await drag("Root request", "Folder");
  expect(store.data.requests.find(request => request.id === root.id)?.folderId).toBeNull();
  expect(store.error).toBe("disk unavailable");
});
it("does not mutate workspace data when a drag is cancelled or dropped outside a row", async () => {
  const store = useWorkspaceStore();
  const before = JSON.stringify(store.data);
  await row("Root request").trigger("dragstart");
  await row("Root request").trigger("dragend");
  await wrapper.get(".data-tree").trigger("drop");
  await flushPromises();
  expect(JSON.stringify(store.data)).toBe(before);
});
it("toggles Cmd/Ctrl request selection without opening and drags all selected requests", async () => {
  const store = useWorkspaceStore();
  const root = store.data.requests.find(request => request.name === "Root request")!;
  const nested = store.data.requests.find(request => request.name === "Nested request")!;
  const folder = store.data.folders.find(value => value.name === "Folder")!;
  await store.open(root.id);
  await row("Root request").trigger("click", { metaKey: true });
  await row("Nested request").trigger("click", { ctrlKey: true });
  expect(row("Root request").classes()).toContain("selected");
  expect(row("Nested request").classes()).toContain("selected");
  expect(wrapper.emitted("open")).toBeUndefined();
  expect(store.activeId).toBe(root.id);
  await row("Root request").trigger("dragstart");
  await row("Folder").trigger("drop");
  await flushPromises();
  expect(store.data.requests.find(value => value.id === root.id)?.folderId).toBe(folder.id);
  expect(store.data.requests.find(value => value.id === nested.id)?.folderId).toBe(folder.id);
});
it("sends selected request IDs in tree display order rather than click order", async () => {
  const store = useWorkspaceStore();
  const root = store.data.requests.find(request => request.name === "Root request")!;
  const nested = store.data.requests.find(request => request.name === "Nested request")!;
  const folder = store.data.folders.find(value => value.name === "Folder")!;
  store.tabs[nested.id]!.draft.body = "requires confirmation";
  await row("Root request").trigger("click", { metaKey: true });
  await row("Nested request").trigger("click", { ctrlKey: true });
  await row("Root request").trigger("dragstart");
  await row("Folder").trigger("drop");
  await flushPromises();
  expect(wrapper.emitted("moveRequests")?.[0]).toEqual([[nested.id, root.id], folder.id]);
});
it("keeps collapsed and search-hidden selections in a dirty Save All & Move request", async () => {
  const store = useWorkspaceStore();
  const root = store.data.requests.find(request => request.name === "Root request")!;
  const nested = store.data.requests.find(request => request.name === "Nested request")!;
  const folder = store.data.folders.find(value => value.name === "Folder")!;
  store.tabs[nested.id]!.draft.body = "requires confirmation";
  await row("Root request").trigger("click", { metaKey: true });
  await row("Nested request").trigger("click", { ctrlKey: true });
  await action("Folder", "Collapse");
  expect(row("Nested request")).toBeUndefined();
  await drag("Root request", "Folder", 5);
  expect(wrapper.emitted("moveRequests")?.[0]).toEqual([[nested.id, root.id], folder.id]);

  await action("Folder", "Expand");
  await wrapper.get('button[aria-label="Search collections"]').trigger("click");
  await wrapper.get('input[aria-label="Search collections"]').setValue("Subfolder");
  expect(row("Root request")).toBeUndefined();
  await drag("Nested request", "Folder", 95);
  expect(wrapper.emitted("moveRequests")?.[1]).toEqual([[nested.id, root.id], folder.id]);
});
