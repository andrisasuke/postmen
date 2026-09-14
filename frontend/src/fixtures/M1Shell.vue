<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onErrorCaptured,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import { useSettingsStore } from "../stores/settings";
import { useViewport } from "../composables/useViewport";
import {
  bootstrapDesktop,
  isDesktop,
  onShellAction,
  setWindowTheme,
} from "../services/desktop";
import type { BootstrapInfo, ShellAction } from "../types/shell";
import type { ReferenceRequest } from "../fixtures/reference";
import TitleBar from "../components/layout/TitleBar.vue";
import CollectionSidebar from "../components/layout/CollectionSidebar.vue";
import EmptyWorkspace from "../components/layout/EmptyWorkspace.vue";
import StatusBar from "../components/layout/StatusBar.vue";
import AppIcon from "../components/ui/AppIcon.vue";
import IconButton from "../components/ui/IconButton.vue";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiMenu from "../components/ui/UiMenu.vue";

const Preview = import.meta.env.DEV
  ? defineAsyncComponent(() => import("../features/ReferencePreview.vue"))
  : null;
const settings = useSettingsStore();
const { width } = useViewport();
const info = ref<BootstrapInfo | null>(null);
const bootState = ref<"loading" | "connected" | "browser" | "error">("loading");
const failure = ref("");
const fatal = ref(false);
const about = ref(false);
const fixture = ref(false);
const requests = ref<ReferenceRequest[]>([]);
const activeId = ref<string | null>(null);
const tabIds = ref<string[]>([]);
const deleting = ref<string | null>(null);
const deletingName = computed(
  () => requests.value.find((r) => r.id === deleting.value)?.name ?? "request",
);
const activeRequest = computed(() =>
  requests.value.find((r) => r.id === activeId.value),
);
const tabs = computed(() =>
  tabIds.value.flatMap((id) => {
    const request = requests.value.find((r) => r.id === id);
    return request ? [request] : [];
  }),
);
const dev = import.meta.env.DEV;
const platform = computed(
  () =>
    info.value?.platform ??
    (/Mac/.test(navigator.platform) ? "macos" : "other"),
);
const compactSidebarOpen = ref(false);
const sidebarVisible = computed(() =>
  width.value < 940
    ? compactSidebarOpen.value
    : !settings.preferences.sidebarCollapsed,
);
function toggleSidebar() {
  if (width.value < 940) compactSidebarOpen.value = !compactSidebarOpen.value;
  else
    settings.preferences.sidebarCollapsed =
      !settings.preferences.sidebarCollapsed;
}
const connection = computed(
  () =>
    ({
      loading: "Connecting to desktop…",
      connected: "Tauri · M1",
      browser: "Browser preview · M1",
      error: "Desktop connection failed",
    })[bootState.value],
);
const showError = (message: string) => {
  failure.value = message;
};
async function connect() {
  bootState.value = "loading";
  try {
    info.value = await bootstrapDesktop();
    bootState.value = info.value ? "connected" : "browser";
  } catch {
    bootState.value = "error";
    showError(
      "Could not connect to the desktop backend. Retry or restart PostMen.",
    );
  }
}
async function preview() {
  if (!import.meta.env.DEV) return;
  try {
    const data = await import("../fixtures/reference");
    requests.value = structuredClone(data.requests);
    fixture.value = true;
    tabIds.value = ["list-users", "create-user"];
    activeId.value = "create-user";
    about.value = false;
  } catch {
    showError(
      "The development preview could not be loaded. Retry when the dev server is available.",
    );
  }
}
function leavePreview() {
  fixture.value = false;
  requests.value = [];
  tabIds.value = [];
  activeId.value = null;
}
function open(id: string) {
  if (!tabIds.value.includes(id)) tabIds.value.push(id);
  activeId.value = id;
  compactSidebarOpen.value = false;
}
function closeTab(id: string) {
  const index = tabIds.value.indexOf(id);
  tabIds.value = tabIds.value.filter((x) => x !== id);
  if (activeId.value === id)
    activeId.value =
      tabIds.value[Math.min(index, tabIds.value.length - 1)] ?? null;
}
function deletePreview() {
  if (!deleting.value) return;
  closeTab(deleting.value);
  requests.value = requests.value.filter((r) => r.id !== deleting.value);
  deleting.value = null;
}
function action(value: ShellAction) {
  if (value === "about") about.value = true;
  if (value === "toggle-sidebar") toggleSidebar();
  if (value === "toggle-layout") settings.toggleLayout();
  if (value === "reset-layout") settings.resetLayout();
}
function shortcuts(event: KeyboardEvent) {
  if (about.value || deleting.value) return;
  if (event.key === "Escape" && compactSidebarOpen.value)
    compactSidebarOpen.value = false;
  if (!(event.metaKey || event.ctrlKey)) return;
  if (!isDesktop() && event.key.toLowerCase() === "b") {
    event.preventDefault();
    action("toggle-sidebar");
  }
  if (!isDesktop() && event.shiftKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    action("toggle-layout");
  }
}
function tabKeydown(event: KeyboardEvent) {
  if (
    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
    !(event.currentTarget instanceof HTMLElement)
  )
    return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) %
          items.length;
  event.preventDefault();
  items[next]?.focus();
  items[next]?.click();
}
const reload = () => location.reload();
watch(
  () => settings.preferences.theme,
  async (theme) => {
    try {
      await setWindowTheme(theme);
    } catch {
      showError("The native window theme could not be updated.");
    }
  },
  { immediate: true },
);
onErrorCaptured(() => {
  fatal.value = true;
  failure.value =
    "This screen encountered an unexpected error. Reload PostMen to recover.";
  return false;
});
let unlisten: (() => void) | undefined;
let disposed = false;
onMounted(async () => {
  void connect();
  window.addEventListener("keydown", shortcuts);
  try {
    const remove = await onShellAction(action);
    if (disposed) remove();
    else unlisten = remove;
  } catch {
    showError("Native menu actions could not be connected.");
  }
  if (
    import.meta.env.DEV &&
    new URLSearchParams(location.search).get("fixture") === "reference"
  )
    void preview();
});
onUnmounted(() => {
  disposed = true;
  unlisten?.();
  window.removeEventListener("keydown", shortcuts);
});
</script>
<template>
  <div
    class="app-shell"
    :data-connection="bootState"
    :data-fixture="fixture"
    data-testid="app-shell"
  >
    <TitleBar
      :platform="platform"
      :has-request="!!activeRequest"
      :sidebar-visible="sidebarVisible"
      @toggle-sidebar="toggleSidebar"
      @home="activeId = null"
      @error="showError"
    />
    <div v-if="fatal" class="fatal-state" role="alert">
      <h1>Unable to display this screen</h1>
      <p>{{ failure }}</p>
      <UiButton @click="reload">Reload PostMen</UiButton>
    </div>
    <div v-else class="app-main">
      <button
        v-if="width < 940 && sidebarVisible"
        class="sidebar-backdrop"
        aria-label="Close collection sidebar"
        @click="compactSidebarOpen = false"
      />
      <CollectionSidebar
        v-if="sidebarVisible"
        :class="{ compact: width < 940 }"
        :fixture="fixture"
        :requests="requests"
        :active-id="activeId"
        @open="open"
        @remove="deleting = $event"
        @about="about = true"
      />
      <main class="workspace" aria-label="Workspace">
        <header class="collection-header">
          <AppIcon
            :name="fixture && activeRequest ? 'cube' : 'square'"
            :size="20"
          /><strong>{{
            fixture && activeRequest ? "PostMen Reference" : "My Workspace"
          }}</strong
          ><span class="spacer" /><span
            v-if="width < 940"
            class="compact-indicator"
            title="Sidebar hidden automatically below 940px"
            >Compact layout</span
          ><UiMenu
            label="Layout options"
            :items="[
              { id: 'toggle-layout', label: 'Toggle response layout' },
              { id: 'reset-layout', label: 'Reset layout' },
              { id: 'about', label: 'About PostMen' },
            ]"
            align="end"
            icon-only
            @select="action($event as ShellAction)"
            ><AppIcon name="dots" /></UiMenu
          ><span
            v-if="fixture && activeRequest"
            class="base-url-placeholder"
            title="Base URL management is available in M2"
            >No Base URL<AppIcon name="down" :size="14"
          /></span>
        </header>
        <div class="request-tabs-bar">
          <div
            v-if="activeRequest"
            class="request-tabs"
            role="tablist"
            aria-label="Open requests"
            @keydown="tabKeydown"
          >
            <div
              v-for="tab in tabs"
              :key="tab.id"
              class="request-tab"
              :class="{ active: activeId === tab.id }"
            >
              <button
                role="tab"
                :aria-selected="activeId === tab.id"
                :tabindex="activeId === tab.id ? 0 : -1"
                @click="activeId = tab.id"
              >
                <span
                  class="method-label"
                  :class="`method-${tab.method.toLowerCase()}`"
                  >{{ tab.method }}</span
                ><span class="tab-name">{{ tab.name }}</span></button
              ><button
                class="close-tab"
                :aria-label="`Close ${tab.name}`"
                @click="closeTab(tab.id)"
              >
                <AppIcon name="x" :size="12" />
              </button>
            </div>
          </div>
          <div v-else class="request-tabs">
            <div class="request-tab active overview-tab">
              <span><AppIcon name="home" :size="14" />Overview</span>
            </div>
          </div>
          <IconButton
            label="New request — available in M2"
            icon="plus"
            disabled
          />
        </div>
        <component
          :is="Preview"
          v-if="fixture && activeRequest && Preview"
          :key="activeRequest.id"
          :request="activeRequest"
        />
        <EmptyWorkspace v-else @about="about = true" />
      </main>
    </div>
    <div
      v-if="(failure && !fatal) || settings.persistenceError"
      class="error-notice"
      role="alert"
    >
      <span>{{ failure || settings.persistenceError }}</span
      ><button v-if="bootState === 'error'" @click="connect">Retry</button
      ><button v-if="failure" aria-label="Dismiss error" @click="failure = ''">
        Dismiss
      </button>
    </div>
    <StatusBar
      :version="info?.version ?? '0.2.0'"
      :connection="connection"
      :fixture="fixture"
      :dev="dev"
      @about="about = true"
      @preview="preview"
      @leave-preview="leavePreview"
    />
    <UiModal :open="about" title="About PostMen" @close="about = false"
      ><p>PostMen <strong>0.2.0 · M1</strong></p>
      <p>
        Tauri 2 + Vue 3 + TypeScript. A fresh workspace with a desktop
        light and dark themes.
      </p>
      <p class="muted">
        This milestone includes the desktop shell, themes, layout, and native
        IPC. Collection storage and editing arrive in M2; HTTP execution arrives
        in M3.
      </p>
      <p data-testid="connection-detail">
        {{ connection }}{{ info ? ` · ${info.platform}` : "" }}
      </p>
      <template #footer
        ><UiButton v-if="dev" @click="preview">Open UI preview</UiButton
        ><UiButton data-autofocus variant="primary" @click="about = false"
          >Close</UiButton
        ></template
      ></UiModal
    >
    <UiModal
      :open="deleting !== null"
      title="Delete Request"
      @close="deleting = null"
      ><p>
        Are you sure you want to delete <strong>{{ deletingName }}</strong
        >?
      </p>
      <template #footer
        ><UiButton data-autofocus variant="ghost" @click="deleting = null"
          >Cancel</UiButton
        ><UiButton variant="danger" @click="deletePreview"
          >Delete</UiButton
        ></template
      ></UiModal
    >
  </div>
</template>
