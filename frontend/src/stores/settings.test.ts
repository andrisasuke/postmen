import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import {
  defaultSettings,
  parseSettings,
  SETTINGS_KEY,
  useSettingsStore,
} from "./settings";

describe("UI preference validation", () => {
  it.each([null, "", "garbage", "null", "[]", '{"theme":"bad"}'])(
    "recovers invalid storage %s",
    (input) => {
      expect(parseSettings(input)).toEqual(defaultSettings());
    },
  );
  it("clamps dimensions, validates enums and prevents both panes being collapsed", () => {
    expect(
      parseSettings(
        JSON.stringify({
          theme: "dark",
          sidebarWidth: 2000,
          requestWidth: -1,
          requestHeight: 0,
          orientation: "diagonal",
          sidebarCollapsed: "yes",
          requestCollapsed: true,
          responseCollapsed: true,
        }),
      ),
    ).toEqual({
      ...defaultSettings(),
      theme: "dark",
      sidebarWidth: 600,
      requestWidth: 350,
      requestHeight: 150,
      responseCollapsed: true,
    });
  });
  it("preserves valid settings", () => {
    const settings = {
      ...defaultSettings(),
      theme: "light",
      orientation: "vertical",
      sidebarWidth: 310,
      requestHeight: 280,
    };
    expect(parseSettings(JSON.stringify(settings))).toEqual(settings);
  });
  it("accepts only boolean expansion states keyed by node UUID and supports older preferences", () => {
    const id = crypto.randomUUID();
    const invalid = crypto.randomUUID();
    expect(parseSettings(JSON.stringify({ theme: "dark" })).treeExpanded).toEqual({});
    expect(parseSettings(JSON.stringify({ treeExpanded: { [id]: false, [invalid]: "false", constructor: false } })).treeExpanded)
      .toEqual({ [id]: false });
    expect(parseSettings('{"treeExpanded":[]}').treeExpanded).toEqual({});
  });
});

describe("theme and layout store", () => {
  let pinia: ReturnType<typeof createPinia>;
  let onChange: ((event: { matches: boolean }) => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: (_: string, listener: typeof onChange) => {
          onChange = listener;
        },
        removeEventListener: vi.fn(),
      })),
    );
  });
  afterEach(() => {
    disposePinia(pinia);
    vi.unstubAllGlobals();
  });
  it("follows system until an explicit choice and persists it", async () => {
    const store = useSettingsStore();
    expect(store.resolvedTheme).toBe("light");
    onChange?.({ matches: true });
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe("dark");
    store.setTheme("light");
    onChange?.({ matches: true });
    await nextTick();
    expect(store.resolvedTheme).toBe("light");
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}").theme).toBe(
      "light",
    );
  });
  it("resets layout without changing theme and never hides both panes", () => {
    const store = useSettingsStore();
    store.setTheme("dark");
    store.togglePane("request");
    store.togglePane("response");
    expect(store.preferences.requestCollapsed).toBe(false);
    expect(store.preferences.responseCollapsed).toBe(true);
    store.toggleLayout();
    store.resetLayout();
    expect(store.preferences).toEqual({ ...defaultSettings(), theme: "dark" });
  });
  it("skips unchanged preference writes, including the queued watcher", async () => {
    const store = useSettingsStore();
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(store.persistPreferences()).toBe(true);
    expect(store.persistPreferences()).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    store.setTheme("dark");
    expect(store.persistPreferences()).toBe(true);
    await nextTick();
    expect(write).toHaveBeenCalledTimes(2);
    expect(store.persistPreferences()).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("restores collection/folder states after restarting the store and preserves them on layout reset", async () => {
    const collection = crypto.randomUUID();
    const folder = crypto.randomUUID();
    const child = crypto.randomUUID();
    const store = useSettingsStore();
    store.preferences.treeExpanded = { [collection]: false, [folder]: true, [child]: false };
    await nextTick();
    disposePinia(pinia);
    pinia = createPinia(); setActivePinia(pinia);
    const restored = useSettingsStore();
    expect(restored.preferences.treeExpanded).toEqual({ [collection]: false, [folder]: true, [child]: false });
    restored.resetLayout();
    expect(restored.preferences.treeExpanded).toEqual({ [collection]: false, [folder]: true, [child]: false });
    restored.preferences.treeExpanded[collection] = true;
    expect(restored.persistPreferences()).toBe(true);
    expect(parseSettings(localStorage.getItem(SETTINGS_KEY)).treeExpanded[collection]).toBe(true);
  });
  it("recognizes loaded preferences and never treats failed writes as saved", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(defaultSettings()));
    const store = useSettingsStore();
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(store.persistPreferences()).toBe(true);
    expect(write).not.toHaveBeenCalled();
    store.setTheme("dark");
    write.mockImplementationOnce(() => { throw new Error("denied"); });
    expect(store.persistPreferences()).toBe(false);
    expect(store.persistPreferences()).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(store.persistenceError).toBe("");
  });
  it("reports unavailable persistence without crashing", async () => {
    const store = useSettingsStore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    store.setTheme("dark");
    await nextTick();
    expect(store.persistenceError).toContain("cannot be saved");
    expect(store.resolvedTheme).toBe("dark");
  });
});
