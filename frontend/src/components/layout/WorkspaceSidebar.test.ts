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
      await trigger.trigger("click", { detail: 1 });
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
  await trigger.trigger("click", { detail: 1 });
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
