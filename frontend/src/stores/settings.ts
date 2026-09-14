import { defineStore } from "pinia";
import { computed, onScopeDispose, ref, watch } from "vue";
import type { Orientation, ThemeMode } from "../types/shell";

export const SETTINGS_KEY = "postmen.shell.settings.v1";
export interface ShellSettings {
  theme: ThemeMode;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  treeExpanded: Record<string, boolean>;
  orientation: Orientation;
  requestWidth: number | null;
  requestHeight: number;
  requestCollapsed: boolean;
  responseCollapsed: boolean;
}
export const defaultSettings = (): ShellSettings => ({
  theme: "system",
  sidebarWidth: 250,
  sidebarCollapsed: false,
  treeExpanded: {},
  orientation: "horizontal",
  requestWidth: null,
  requestHeight: 380,
  requestCollapsed: false,
  responseCollapsed: false,
});
export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export function parseSettings(raw: string | null): ShellSettings {
  const result = defaultSettings();
  if (!raw) return result;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!value || typeof value !== "object") return result;
  const data = value as Record<string, unknown>;
  if (data.treeExpanded && typeof data.treeExpanded === "object" && !Array.isArray(data.treeExpanded)) {
    for (const [id, expanded] of Object.entries(data.treeExpanded)) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        && typeof expanded === "boolean") result.treeExpanded[id] = expanded;
    }
  }
  if (
    data.theme === "light" ||
    data.theme === "dark" ||
    data.theme === "system"
  )
    result.theme = data.theme;
  if (data.orientation === "horizontal" || data.orientation === "vertical")
    result.orientation = data.orientation;
  if (
    typeof data.sidebarWidth === "number" &&
    Number.isFinite(data.sidebarWidth)
  )
    result.sidebarWidth = clamp(data.sidebarWidth, 220, 600);
  if (
    typeof data.requestWidth === "number" &&
    Number.isFinite(data.requestWidth)
  )
    result.requestWidth = clamp(data.requestWidth, 350, 10000);
  if (
    typeof data.requestHeight === "number" &&
    Number.isFinite(data.requestHeight)
  )
    result.requestHeight = clamp(data.requestHeight, 150, 10000);
  for (const key of [
    "sidebarCollapsed",
    "requestCollapsed",
    "responseCollapsed",
  ] as const) {
    if (typeof data[key] === "boolean") result[key] = data[key];
  }
  if (result.requestCollapsed && result.responseCollapsed)
    result.requestCollapsed = false;
  return result;
}

export const useSettingsStore = defineStore("settings", () => {
  const persistenceError = ref("");
  let initial = defaultSettings();
  let persisted: string | null = null;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    initial = parseSettings(raw);
    if (raw === JSON.stringify(initial)) persisted = raw;
  } catch {
    persistenceError.value = "UI preferences could not be loaded.";
  }
  const preferences = ref(initial);
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const systemDark = ref(query.matches);
  const updateSystem = (event: MediaQueryListEvent) => {
    systemDark.value = event.matches;
  };
  query.addEventListener("change", updateSystem);
  onScopeDispose(() => query.removeEventListener("change", updateSystem));
  const resolvedTheme = computed(() =>
    preferences.value.theme === "system"
      ? systemDark.value
        ? "dark"
        : "light"
      : preferences.value.theme,
  );
  watch(
    resolvedTheme,
    (theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    },
    { immediate: true, flush: "sync" },
  );
  function persistPreferences(): boolean {
    try {
      const serialized = JSON.stringify(preferences.value);
      if (serialized === persisted) return true;
      localStorage.setItem(SETTINGS_KEY, serialized);
      persisted = serialized;
      persistenceError.value = "";
      return true;
    } catch {
      persisted = null;
      persistenceError.value =
        "UI preferences cannot be saved. Changes last for this session only.";
      return false;
    }
  }
  watch(preferences, persistPreferences, { deep: true, flush: "post" });
  const setTheme = (theme: ThemeMode) => {
    preferences.value.theme = theme;
  };
  const toggleLayout = () => {
    preferences.value.orientation =
      preferences.value.orientation === "horizontal"
        ? "vertical"
        : "horizontal";
  };
  const togglePane = (pane: "request" | "response") => {
    const key = pane === "request" ? "requestCollapsed" : "responseCollapsed";
    const other = pane === "request" ? "responseCollapsed" : "requestCollapsed";
    preferences.value[key] = !preferences.value[key];
    if (preferences.value[key]) preferences.value[other] = false;
  };
  const resetLayout = () => {
    preferences.value = {
      ...defaultSettings(),
      theme: preferences.value.theme,
      treeExpanded: preferences.value.treeExpanded,
    };
  };
  return {
    preferences,
    persistenceError,
    persistPreferences,
    resolvedTheme,
    setTheme,
    toggleLayout,
    togglePane,
    resetLayout,
  };
});
