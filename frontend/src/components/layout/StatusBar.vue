<script setup lang="ts">
import { computed } from "vue";
import { useSettingsStore } from "../../stores/settings";
import type { ThemeMode } from "../../types/shell";
import AppIcon from "../ui/AppIcon.vue";
import IconButton from "../ui/IconButton.vue";
import UiMenu from "../ui/UiMenu.vue";
defineProps<{
  version: string;
  connection: string;
  fixture: boolean;
  dev: boolean;
}>();
defineEmits<{ about: []; preview: []; leavePreview: [] }>();
const settings = useSettingsStore();
const themeItems = computed(() =>
  (["light", "dark", "system"] as const).map((id) => ({
    id,
    label: `${id[0]?.toUpperCase()}${id.slice(1)}`,
    checked: settings.preferences.theme === id,
  })),
);
function changeTheme(id: string) {
  if (["light", "dark", "system"].includes(id))
    settings.setTheme(id as ThemeMode);
}
</script>
<template>
  <footer class="status-bar" data-testid="statusbar">
    <div class="status-left">
      <IconButton
        label="About PostMen"
        icon="settings"
        @click="$emit('about')"
      /><UiMenu
        label="Change theme"
        :items="themeItems"
        side="top"
        icon-only
        @select="changeTheme"
        ><AppIcon name="palette" /></UiMenu
      ><button
        v-if="dev"
        class="status-link"
        @click="fixture ? $emit('leavePreview') : $emit('preview')"
      >
        {{ fixture ? "Exit UI preview" : "UI preview" }}</button
      ><span v-if="fixture" class="preview-label">Fixture · no saved data</span>
    </div>
    <span class="spacer" /><button
      class="status-link connection-status"
      @click="$emit('about')"
    >
      {{ connection }}</button
    ><span class="app-version">v{{ version }}</span>
  </footer>
</template>
