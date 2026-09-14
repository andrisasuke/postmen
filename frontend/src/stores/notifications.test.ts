import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { useNotificationsStore } from "./notifications";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { vi.useFakeTimers(); pinia = createPinia(); setActivePinia(pinia); });
afterEach(() => { disposePinia(pinia); vi.useRealTimers(); });

describe("notification lifecycle", () => {
  it("expires success and error toasts at their separate durations", () => {
    const store = useNotificationsStore();
    store.success("Saved"); store.error("Failed");
    vi.advanceTimersByTime(3500);
    expect(store.items.map(item => item.message)).toEqual(["Failed"]);
    vi.advanceTimersByTime(2500);
    expect(store.items).toEqual([]);
  });
  it("refreshes repeated messages without duplicate cards and caps the stack at three", () => {
    const store = useNotificationsStore();
    const id = store.success("Saved");
    vi.advanceTimersByTime(3000);
    expect(store.success("Saved")).toBe(id);
    vi.advanceTimersByTime(1000);
    expect(store.items).toHaveLength(1);
    store.success("Created"); store.error("Failed"); store.success("Renamed");
    expect(store.items.map(item => item.message)).toEqual(["Created", "Failed", "Renamed"]);
    expect(vi.getTimerCount()).toBe(3);
  });
  it("pauses for pointer and keyboard focus independently, then resumes the remaining time", () => {
    const store = useNotificationsStore();
    const id = store.success("Saved");
    vi.advanceTimersByTime(1000);
    store.pause(id, "pointer"); store.pause(id, "focus");
    vi.advanceTimersByTime(10000);
    store.resume(id, "pointer");
    vi.advanceTimersByTime(10000);
    expect(store.items).toHaveLength(1);
    store.resume(id, "focus");
    vi.advanceTimersByTime(2499);
    expect(store.items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.items).toEqual([]);
  });
  it("dismisses manually and releases all timers on disposal", () => {
    const store = useNotificationsStore();
    const id = store.error("Failed");
    store.dismiss(id);
    expect(store.items).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    store.success("Saved"); store.error("Failed");
    disposePinia(pinia);
    expect(vi.getTimerCount()).toBe(0);
  });
});
