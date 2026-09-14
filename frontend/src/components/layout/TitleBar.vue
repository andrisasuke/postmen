<script setup lang="ts">
import { computed } from "vue";
import { useSettingsStore } from "../../stores/settings";
import {
  isDesktop,
  startTitlebarDrag,
  windowControl,
} from "../../services/desktop";
import AppIcon from "../ui/AppIcon.vue";
import IconButton from "../ui/IconButton.vue";
const props = defineProps<{
  platform: string;
  hasRequest: boolean;
  sidebarVisible: boolean;
}>();
const emit = defineEmits<{
  home: [];
  toggleSidebar: [];
  error: [message: string];
}>();
const settings = useSettingsStore();
const mac = computed(
  () => props.platform === "macos" || props.platform === "darwin",
);
async function control(action: "minimize" | "maximize" | "close") {
  try {
    await windowControl(action);
  } catch {
    emit("error", "The window action could not be completed.");
  }
}
async function drag(event: MouseEvent) {
  if (
    !mac.value || !isDesktop() || event.button !== 0 || event.detail !== 1 ||
    !(event.target instanceof HTMLElement) ||
    !event.target.hasAttribute("data-tauri-drag-region")
  ) return;
  // Use the original app-local NSEvent, before IPC replaces NSApp.currentEvent.
  // Other platforms and macOS double-click retain Tauri's standard behavior.
  event.preventDefault();
  event.stopPropagation();
  try {
    await startTitlebarDrag();
  } catch {
    emit("error", "The window could not be dragged.");
  }
}
</script>
<template>
  <header
    class="app-titlebar"
    :class="{ 'os-mac': mac }"
    data-testid="titlebar"
    data-tauri-drag-region
    @mousedown="drag"
  >
    <div class="titlebar-left">
      <IconButton label="Home" icon="home" @click="emit('home')" /><slot name="workspace"><span
        class="workspace-name"
        >My Workspace</span
      ></slot>
    </div>
    <div class="titlebar-brand" data-tauri-drag-region>
      <img class="brand-mark" src="/titlebar-icon.svg" alt="" draggable="false" /><span>PostMen</span>
    </div>
    <div class="titlebar-right">
      <IconButton
        label="Toggle sidebar"
        :icon="sidebarVisible ? 'sidebar' : 'sidebarExpand'"
        @click="emit('toggleSidebar')"
      />
      <IconButton
        label="Collapse response pane"
        icon="collapse"
        :disabled="!hasRequest"
        :active="settings.preferences.responseCollapsed"
        @click="settings.togglePane('response')"
      />
      <IconButton
        label="Toggle response layout"
        :icon="
          settings.preferences.orientation === 'horizontal' ? 'rows' : 'columns'
        "
        :disabled="!hasRequest"
        @click="settings.toggleLayout"
      />
      <div v-if="!mac && isDesktop()" class="window-controls">
        <button aria-label="Minimize window" @click="control('minimize')">
          <AppIcon name="minus" /></button
        ><button aria-label="Maximize window" @click="control('maximize')">
          <AppIcon name="square" /></button
        ><button
          class="window-close"
          aria-label="Close window"
          @click="control('close')"
        >
          <AppIcon name="x" />
        </button>
      </div>
    </div>
  </header>
</template>
