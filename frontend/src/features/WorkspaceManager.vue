<script setup lang="ts">
import { computed } from "vue";
import { useWorkspacesStore } from "../stores/workspaces";
import AppIcon from "../components/ui/AppIcon.vue";
import IconButton from "../components/ui/IconButton.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiModal from "../components/ui/UiModal.vue";
const emit = defineEmits<{ open: [id: string]; create: []; back: [] }>();
const props = defineProps<{ disabled?: boolean }>();
const workspaces = useWorkspacesStore();
const locked = computed(() => props.disabled || workspaces.busy || workspaces.needsRecovery);
const deleting = computed(() => workspaces.catalog?.workspaces.find(entry => entry.id === workspaces.deletingId));
function askDelete(id: string) {
  if (locked.value || id === workspaces.catalog?.defaultId) return;
  workspaces.failure = "";
  workspaces.deletingId = id;
}
function cancelDelete() {
  if (locked.value) return;
  workspaces.deletingId = null;
  workspaces.failure = "";
}
</script>
<template>
  <main class="workspace-manager" aria-label="Manage workspaces" :aria-busy="workspaces.busy">
    <header class="workspace-manager-toolbar">
      <IconButton label="Back to workspace" icon="back" :disabled="locked" @click="emit('back')" />
      <h1>Manage Workspaces</h1>
      <span class="spacer" />
      <UiButton variant="primary" :disabled="locked" @click="emit('create')"><AppIcon name="plus" />Create Workspace</UiButton>
    </header>
    <div class="workspace-manager-list">
      <article v-for="entry in workspaces.catalog?.workspaces ?? []" :key="entry.id" class="workspace-manager-row" :data-workspace-id="entry.id">
        <div class="workspace-manager-info">
          <div class="workspace-manager-name">
            <AppIcon :name="entry.id === workspaces.catalog?.defaultId ? 'lock' : 'workspace'" :size="20" />
            <h2>{{ entry.name }}</h2>
            <span v-if="entry.id === workspaces.catalog?.defaultId" class="workspace-badge">Default</span>
            <span v-if="entry.id === workspaces.catalog?.activeId" class="workspace-badge current">Active</span>
          </div>
          <p v-if="entry.id === workspaces.catalog?.defaultId" class="muted">Opens when the application starts.</p>
        </div>
        <div class="workspace-manager-actions">
          <IconButton :label="`Open ${entry.name}`" icon="openWorkspace" :disabled="locked" @click="emit('open', entry.id)" />
          <template v-if="entry.id !== workspaces.catalog?.defaultId">
            <IconButton :label="`Set ${entry.name} as default`" icon="star" :disabled="locked" @click="workspaces.manage('default', entry.id)" />
            <IconButton class="workspace-delete-action" :label="`Delete ${entry.name}`" icon="trash" :disabled="locked" @click="askDelete(entry.id)" />
          </template>
        </div>
      </article>
      <p v-if="workspaces.failure && !deleting && !workspaces.needsRecovery" class="inline-error" role="alert">{{ workspaces.failure }}</p>
    </div>
    <UiModal :open="!!deleting" title="Delete Workspace" :busy="workspaces.busy" @close="cancelDelete">
      <p>Delete <strong>{{ deleting?.name }}</strong> from the workspace list?</p>
      <p class="muted">Its collections, environments and request history will no longer appear in the application. The database files will stay on disk for recovery; this does not permanently erase them.</p>
      <p v-if="deleting?.id === workspaces.catalog?.activeId">The default workspace will open after deletion.</p>
      <p v-if="workspaces.failure" class="inline-error" role="alert">{{ workspaces.failure }}</p>
      <template #footer>
        <UiButton data-autofocus :disabled="locked" @click="cancelDelete">Cancel</UiButton>
        <UiButton variant="danger" :disabled="locked || !deleting || deleting.id === workspaces.catalog?.defaultId" @click="deleting && workspaces.manage('delete', deleting.id)">{{ workspaces.busy ? 'Deleting…' : 'Delete' }}</UiButton>
      </template>
    </UiModal>
  </main>
</template>
