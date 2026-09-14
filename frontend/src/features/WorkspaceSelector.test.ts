import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import WorkspaceSelector from "./WorkspaceSelector.vue";
import WorkspaceNameForm from "./WorkspaceNameForm.vue";
import WorkspaceManager from "./WorkspaceManager.vue";
import { useWorkspacesStore } from "../stores/workspaces";

let pinia: ReturnType<typeof createPinia>;
let wrapper: VueWrapper | undefined;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  pinia = createPinia(); setActivePinia(pinia);
  useWorkspacesStore().catalog = {
    version: 1, activeId: "00000000-0000-4000-8000-000000000002",
    defaultId: "00000000-0000-4000-8000-000000000001",
    workspaces: [
      { id: "00000000-0000-4000-8000-000000000001", name: "My Workspace" },
      { id: "00000000-0000-4000-8000-000000000002", name: "Shopping" },
    ],
  };
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; disposePinia(pinia); document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("shows the active workspace, selection check and Create workspace action", async () => {
  wrapper = mount(WorkspaceSelector, { props: { disabled: false }, attachTo: document.body });
  expect(wrapper.get(".workspace-selector-name").text()).toBe("Shopping");
  await wrapper.get('[aria-label="Select workspace"]').trigger("click", { detail: 1 });
  await flushPromises();
  expect(document.querySelector('[role="menuitemradio"][aria-label="Shopping"]')?.getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector(".workspace-menu-heading")?.textContent).toBe("Workspaces");
  document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="Create workspace"]')!.click();
  expect(wrapper.emitted("create")).toEqual([[]]);
});
it("selects a workspace through keyboard navigation", async () => {
  wrapper = mount(WorkspaceSelector, { props: { disabled: false }, attachTo: document.body });
  await wrapper.get('[aria-label="Select workspace"]').trigger("keydown", { key: "ArrowDown" });
  await flushPromises();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("My Workspace");
  (document.activeElement as HTMLButtonElement).click();
  expect(wrapper.emitted("select")).toEqual([["00000000-0000-4000-8000-000000000001"]]);
});
it("places Manage workspaces below Create workspace and opens it", async () => {
  wrapper = mount(WorkspaceSelector, { props: { disabled: false }, attachTo: document.body });
  await wrapper.get('[aria-label="Select workspace"]').trigger("click");
  await flushPromises();
  const actions = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')];
  expect(actions.slice(-2).map(button => button.textContent?.trim())).toEqual(["Create workspace", "Manage workspaces"]);
  actions.at(-1)!.click();
  expect(wrapper.emitted("manage")).toEqual([[]]);
});
it("shows only Open on the default row and three icon actions on other rows", async () => {
  wrapper = mount(WorkspaceManager, { attachTo: document.body });
  const rows = wrapper.findAll(".workspace-manager-row");
  expect(rows[0]!.findAll("button").map(button => button.attributes("aria-label"))).toEqual(["Open My Workspace"]);
  expect(rows[1]!.findAll("button").map(button => button.attributes("aria-label"))).toEqual([
    "Open Shopping", "Set Shopping as default", "Delete Shopping",
  ]);
  expect(rows[1]!.findAll("button").every(button => button.text() === "")).toBe(true);
  await rows[1]!.get('[aria-label="Open Shopping"]').trigger("click");
  expect(wrapper.emitted("open")).toEqual([["00000000-0000-4000-8000-000000000002"]]);
  await wrapper.get(".workspace-manager-toolbar .ui-button").trigger("click");
  expect(wrapper.emitted("create")).toEqual([[]]);
});
it("requires confirmation and permits cancelling workspace deletion", async () => {
  wrapper = mount(WorkspaceManager, { attachTo: document.body });
  await wrapper.get('[aria-label="Delete Shopping"]').trigger("click");
  await flushPromises();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("database files will stay on disk");
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent?.trim() === "Cancel")!;
  cancel.click(); await flushPromises();
  expect(useWorkspacesStore().deletingId).toBeNull();
  expect(useWorkspacesStore().catalog?.workspaces).toHaveLength(2);
});
it("prefills and selects the inline name, and exposes confirm/cancel buttons", async () => {
  useWorkspacesStore().creating = true;
  wrapper = mount(WorkspaceNameForm, { attachTo: document.body });
  const input = wrapper.get<HTMLInputElement>('[aria-label="Workspace name"]');
  expect(input.element.value).toBe("Untitled Workspace");
  expect(document.activeElement).toBe(input.element);
  expect(input.element.selectionStart).toBe(0);
  expect(input.element.selectionEnd).toBe("Untitled Workspace".length);
  await input.setValue("Shopping 2");
  await wrapper.get("form").trigger("submit");
  expect(wrapper.emitted("save")).toEqual([[]]);
  await wrapper.get('[aria-label="Cancel workspace creation"]').trigger("click");
  expect(wrapper.emitted("cancel")).toEqual([[]]);
});
