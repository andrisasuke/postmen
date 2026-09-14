<script setup lang="ts">
import { computed } from "vue";
import { useWorkspacesStore } from "../stores/workspaces";
import UiMenu from "../components/ui/UiMenu.vue";
import AppIcon from "../components/ui/AppIcon.vue";
defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ create: []; manage: []; select: [id: string] }>();
const workspaces = useWorkspacesStore();
const items = computed(() => [
  ...(workspaces.catalog?.workspaces ?? []).map(entry => ({
    id: entry.id, label: entry.name, checked: entry.id === workspaces.catalog?.activeId,
  })),
  { id: "create-workspace", label: "Create workspace" },
  { id: "manage-workspaces", label: "Manage workspaces" },
]);
</script>
<template>
  <UiMenu
    class="workspace-selector"
    label="Select workspace"
    menu-class="workspace-menu"
    :disabled="disabled || !workspaces.catalog"
    :items="items"
    @select="$event === 'create-workspace' ? emit('create') : $event === 'manage-workspaces' ? emit('manage') : emit('select', $event)"
  >
    <span class="workspace-selector-name">{{ workspaces.activeName }}</span>
    <AppIcon name="down" :size="14" />
    <template #before-item="{ item }">
      <div v-if="item.id === 'create-workspace'" class="workspace-menu-heading" role="presentation">Workspaces</div>
    </template>
    <template #item="{ item }">
      <AppIcon v-if="item.id === 'create-workspace'" name="plus" :size="16" />
      <AppIcon v-if="item.id === 'manage-workspaces'" name="settings" :size="16" />
      <span class="workspace-menu-name">{{ item.label }}</span>
      <AppIcon v-if="item.checked" name="check" :size="16" />
    </template>
  </UiMenu>
</template>
