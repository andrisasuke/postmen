import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryApi } from "../fixtures/memory-api";
import { useWorkspaceStore } from "../stores/workspace";
import { newRow } from "../types/data";
import EnvironmentSelector from "./EnvironmentSelector.vue";

let pinia: ReturnType<typeof createPinia>;
let store: ReturnType<typeof useWorkspaceStore>;
let api: ReturnType<typeof createMemoryApi>;
let wrapper: VueWrapper;
let collectionId: string;
let collectionEnvId: string;
let globalEnvId: string;
const trigger = () => wrapper.get(".environment-trigger");
async function click(selector: string, text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find(item => item.textContent?.trim() === text);
  expect(button).toBeDefined();
  button!.click();
  await flushPromises();
}
beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  pinia = createPinia();
  setActivePinia(pinia);
  api = createMemoryApi();
  store = useWorkspaceStore();
  await store.initialize(api);
  collectionId = (await store.createCollection("API")).id;
  collectionEnvId = (await store.saveEnvironment({ id: null, collectionId, name: "staging", revision: null,
    variables: [{ ...newRow(), name: "api_url", value: "collection" }] })).id;
  globalEnvId = (await store.saveEnvironment({ id: null, collectionId: null, name: "Global-Staging", revision: null,
    variables: [{ ...newRow(), name: "api_url", value: "global" }, { ...newRow(), name: "shared", value: "shared-value" }] })).id;
  wrapper = mount(EnvironmentSelector, { props: { collectionId }, attachTo: document.body });
});
afterEach(() => {
  wrapper.unmount();
  disposePinia(pinia);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("independent Collection and Global environment selection", () => {
  it("shows none, Collection only, both, Global only, then none without clearing the other scope", async () => {
    expect(trigger().text()).toBe("No Environment");
    await trigger().trigger("click");
    await click(".environment-choice", "staging");
    expect(trigger().text()).toBe("staging");
    expect(wrapper.find('[data-scope="global"]').exists()).toBe(false);

    await trigger().trigger("click");
    await click(".environment-scope-tabs button", "Global");
    await click(".environment-choice", "Global-Staging");
    expect(wrapper.get('[data-scope="collection"]').text()).toBe("staging");
    expect(wrapper.get('[data-scope="global"]').text()).toBe("Global-Staging");
    expect(trigger().attributes("title")).toBe("Collection: staging · Global: Global-Staging");
    expect(store.variablesFor(collectionId).find(v => v.name === "api_url")?.value).toBe("collection");
    expect(store.variablesFor(collectionId).find(v => v.name === "shared")?.value).toBe("shared-value");
    expect((await api.loadWorkspace()).environmentSelections).toEqual(expect.arrayContaining([
      { collectionId, environmentId: collectionEnvId }, { collectionId: null, environmentId: globalEnvId },
    ]));

    await trigger().trigger("click");
    await click(".environment-choice", "No Environment");
    expect(wrapper.find('[data-scope="collection"]').exists()).toBe(false);
    expect(trigger().text()).toBe("Global-Staging");
    expect(store.variablesFor(collectionId).find(v => v.name === "api_url")?.value).toBe("global");

    await trigger().trigger("click");
    expect(document.querySelector('.environment-scope-tabs button[aria-pressed="true"]')?.textContent).toBe("Global");
    await click(".environment-choice", "No Environment");
    expect(trigger().text()).toBe("No Environment");
  });

  it("retains Collection when Global is cleared and follows the active collection", async () => {
    await store.selectEnvironment(collectionId, collectionEnvId);
    await store.selectEnvironment(null, globalEnvId);
    await trigger().trigger("click");
    await click(".environment-scope-tabs button", "Global");
    await click(".environment-choice", "No Environment");
    expect(trigger().text()).toBe("staging");
    expect(store.selectedEnvironment(collectionId)?.id).toBe(collectionEnvId);
    const other = await store.createCollection("Other");
    await store.selectEnvironment(null, globalEnvId);
    await wrapper.setProps({ collectionId: other.id });
    expect(trigger().text()).toBe("Global-Staging");
    await wrapper.setProps({ collectionId });
    expect(wrapper.get('[data-scope="collection"]').text()).toBe("staging");
  });

  it("supports Global without a collection and closes with Escape", async () => {
    await wrapper.setProps({ collectionId: null });
    await trigger().trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    expect(document.querySelector<HTMLButtonElement>(".environment-scope-tabs button")?.disabled).toBe(true);
    await click(".environment-choice", "Global-Staging");
    expect(trigger().text()).toBe("Global-Staging");
    await trigger().trigger("click");
    document.querySelector(".environment-popover")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(document.querySelector(".environment-popover")).toBeNull();
  });

  it("preserves both selections and keeps the menu open after a save failure", async () => {
    await store.selectEnvironment(collectionId, collectionEnvId);
    await store.selectEnvironment(null, globalEnvId);
    vi.spyOn(api, "selectEnvironment").mockRejectedValueOnce(new Error("Save failed"));
    await trigger().trigger("click");
    await click(".environment-choice", "No Environment");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Save failed");
    expect(wrapper.findAll(".environment-segment")).toHaveLength(2);
  });
});
