<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { clamp, useSettingsStore } from "../../stores/settings";
import type { ReferenceRequest } from "../../fixtures/reference";
import AppIcon from "../ui/AppIcon.vue";
import IconButton from "../ui/IconButton.vue";
import UiInput from "../ui/UiInput.vue";
import UiMenu from "../ui/UiMenu.vue";
const props = defineProps<{
  requests: ReferenceRequest[];
  activeId: string | null;
  fixture: boolean;
}>();
const emit = defineEmits<{
  open: [id: string];
  remove: [id: string];
  about: [];
}>();
const settings = useSettingsStore();
const search = ref("");
const showSearch = ref(false);
const collectionExpanded = ref(true);
const folders = ref<Record<string, boolean>>({ Users: true, Assets: false });
const filtered = computed(() =>
  props.requests.filter((request) =>
    request.name.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const menu = ref<InstanceType<typeof UiMenu>>();
const contextId = ref<string | null>(null);
function context(event: MouseEvent, id: string) {
  event.preventDefault();
  contextId.value = id;
  void menu.value?.openAt(event.clientX, event.clientY);
}
function contextAction(id: string) {
  if (!contextId.value) return;
  if (id === "open") emit("open", contextId.value);
  if (id === "delete") emit("remove", contextId.value);
}
function move(event: PointerEvent) {
  settings.preferences.sidebarWidth = clamp(event.clientX, 220, 600);
}
function stop() {
  document.documentElement.classList.remove("resizing");
  window.removeEventListener("pointermove", move);
  window.removeEventListener("pointerup", stop);
  window.removeEventListener("pointercancel", stop);
  window.removeEventListener("blur", stop);
}
function start(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  document.documentElement.classList.add("resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("blur", stop);
}
function resizeKey(event: KeyboardEvent) {
  if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) {
    event.preventDefault();
    settings.preferences.sidebarWidth =
      event.key === "Home"
        ? 250
        : clamp(
            settings.preferences.sidebarWidth +
              (event.key === "ArrowLeft" ? -10 : 10),
            220,
            600,
          );
  }
}
onBeforeUnmount(stop);
</script>
<template>
  <aside
    class="collection-sidebar"
    :style="{ width: `${settings.preferences.sidebarWidth}px` }"
    data-testid="sidebar"
    aria-label="Collections"
  >
    <div class="sidebar-heading">
      <AppIcon name="cube" /><strong>Collections</strong
      ><span class="spacer" /><IconButton
        label="Search collections"
        icon="search"
        :active="showSearch"
        @click="showSearch = !showSearch"
      /><IconButton
        label="Create collection — available in M2"
        icon="plus"
        disabled
      /><IconButton
        label="About this milestone"
        icon="dotsVertical"
        @click="emit('about')"
      />
    </div>
    <div v-if="showSearch" class="sidebar-search">
      <UiInput
        v-model="search"
        label="Search collections"
        placeholder="Search collections…"
      />
    </div>
    <div v-if="!fixture" class="sidebar-empty">
      No collections found.<br /><span
        >Create collections in milestone M2.</span
      >
    </div>
    <div v-else class="collection-tree" aria-label="Reference collection">
      <button
        class="tree-collection"
        :aria-expanded="collectionExpanded"
        @click="collectionExpanded = !collectionExpanded"
      >
        <AppIcon :name="collectionExpanded ? 'down' : 'right'" />PostMen
        Reference
      </button>
      <div v-if="collectionExpanded" class="tree-content">
        <div
          v-for="folder in ['Assets', 'Users']"
          :key="folder"
          class="tree-folder"
        >
          <button
            class="tree-folder-label"
            :aria-expanded="!!folders[folder] || !!search"
            @click="folders[folder] = !folders[folder]"
          >
            <AppIcon :name="folders[folder] || search ? 'down' : 'right'" />{{
              folder
            }}
          </button>
          <div v-if="folders[folder] || search" class="folder-children">
            <button
              v-for="request in filtered.filter((r) => r.folder === folder)"
              :key="request.id"
              class="tree-request"
              :class="{ selected: activeId === request.id }"
              :aria-current="activeId === request.id ? 'page' : undefined"
              @click="emit('open', request.id)"
              @contextmenu="context($event, request.id)"
            >
              <span
                class="method-label"
                :class="`method-${request.method.toLowerCase()}`"
                >{{ request.method }}</span
              ><span>{{ request.name }}</span>
            </button>
          </div>
        </div>
        <button
          v-for="request in filtered.filter((r) => !r.folder)"
          :key="request.id"
          class="tree-request root-request"
          :class="{ selected: activeId === request.id }"
          @click="emit('open', request.id)"
          @contextmenu="context($event, request.id)"
        >
          <span
            class="method-label"
            :class="`method-${request.method.toLowerCase()}`"
            >{{ request.method }}</span
          >{{ request.name }}
        </button>
        <p v-if="!filtered.length" class="sidebar-empty">
          No matching requests.
        </p>
      </div>
    </div>
    <div v-if="fixture" class="context-anchor">
      <UiMenu
        ref="menu"
        label="Reference request actions"
        :items="[
          { id: 'open', label: 'Open request' },
          { id: 'delete', label: 'Delete preview request', danger: true },
        ]"
        icon-only
        @select="contextAction"
        ><AppIcon name="dots"
      /></UiMenu>
    </div>
    <div
      class="sidebar-resizer"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      :aria-valuenow="settings.preferences.sidebarWidth"
      :aria-valuemin="220"
      :aria-valuemax="600"
      tabindex="0"
      @pointerdown="start"
      @keydown="resizeKey"
      @dblclick="settings.preferences.sidebarWidth = 250"
    />
  </aside>
</template>
