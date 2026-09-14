import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useNotificationsStore } from "../../stores/notifications";
import ToastHost from "./ToastHost.vue";

let pinia: ReturnType<typeof createPinia>;
let wrapper: VueWrapper;
beforeEach(() => {
  vi.useFakeTimers();
  pinia = createPinia(); setActivePinia(pinia);
  wrapper = mount(ToastHost, { attachTo: document.body });
});
afterEach(() => { wrapper.unmount(); disposePinia(pinia); document.body.replaceChildren(); vi.useRealTimers(); });

describe("toast presentation", () => {
  it("announces successes and errors without moving focus or rendering HTML", async () => {
    const input = document.createElement("input"); document.body.append(input); input.focus();
    const store = useNotificationsStore();
    store.success("Request saved successfully"); store.error("<img src=x> Failed to create request");
    await nextTick();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Request saved successfully");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("<img src=x>");
    expect(document.querySelector(".toast-card img")).toBeNull();
    expect(document.activeElement).toBe(input);
  });
  it("allows dismissal and clears notifications when the host unmounts", async () => {
    const store = useNotificationsStore();
    store.success("Saved"); await nextTick();
    document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click();
    await nextTick();
    expect(store.items).toEqual([]);
    store.error("Failed"); await nextTick();
    wrapper.unmount();
    expect(store.items).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
