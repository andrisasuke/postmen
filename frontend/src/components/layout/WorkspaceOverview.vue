<script setup lang="ts">
import { useWorkspaceStore } from "../../stores/workspace";
import AppIcon from "../ui/AppIcon.vue";
import UiButton from "../ui/UiButton.vue";
defineProps<{ creatingWorkspace?: boolean }>();
defineEmits<{
  create: [];
  about: [];
  environments: [];
  request: [collectionId: string];
}>();
const store = useWorkspaceStore();
</script>
<template>
  <div class="empty-workspace">
    <section class="overview-content" aria-label="Workspace overview">
      <div class="workspace-counts">
        <div>
          <strong>{{ creatingWorkspace ? 0 : store.data.collections.length }}</strong
          ><span>Collections</span>
        </div>
        <div>
          <strong>{{ creatingWorkspace ? 0 : store.data.environments.length }}</strong
          ><span>Environments</span>
        </div>
      </div>
      <h2>Quick Actions</h2>
      <div class="quick-actions">
        <UiButton
          variant="soft"
          :disabled="!store.ready || creatingWorkspace"
          @click="$emit('create')"
          ><AppIcon name="plus" />Create Collection</UiButton
        ><UiButton :disabled="!store.ready || creatingWorkspace" @click="$emit('environments')"
          >Manage Environments</UiButton
        >
      </div>
      <h2>Collections</h2>
      <div v-if="creatingWorkspace || !store.data.collections.length" class="empty-collection">
        <AppIcon name="cube" :size="30" />
        <h3>No collections yet</h3>
        <p>Your new workspace starts here.</p>
        <p class="muted">
          {{
            creatingWorkspace
              ? "Confirm the workspace name above to get started."
              : store.ready
              ? "Create a collection to organize your requests."
              : "Open the Tauri desktop application to store and edit requests."
          }}
        </p>
      </div>
      <div v-else class="overview-collections">
        <div
          v-for="collection in store.data.collections"
          :key="collection.id"
          class="overview-collection"
        >
          <AppIcon name="cube" /><strong>{{ collection.name }}</strong
          ><span class="muted"
            >{{
              store.data.requests.filter(
                (r) => r.collectionId === collection.id,
              ).length
            }}
            requests</span
          ><span class="spacer" /><UiButton
            @click="$emit('request', collection.id)"
            >New request</UiButton
          >
        </div>
      </div>
    </section>
    <aside v-if="!creatingWorkspace" class="workspace-guide">
      <header><AppIcon name="file" />Getting started</header>
      <div>
        <AppIcon name="file" :size="48" />
        <p>PostMen · Tauri + Vue</p>
        <p class="muted">Create, edit, and save requests locally.</p>
        <ul>
          <li>New SQLite workspace</li>
          <li>Independent drafts and JSON editing</li>
          <li>Send and cancel HTTP requests in the desktop app</li>
        </ul>
        <UiButton variant="soft" @click="$emit('about')"
          ><AppIcon name="info" />About this milestone</UiButton
        >
      </div>
    </aside>
  </div>
</template>
