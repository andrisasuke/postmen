<script setup lang="ts">
import AppIcon from "../ui/AppIcon.vue";
import UiButton from "../ui/UiButton.vue";
defineEmits<{ about: [] }>();
</script>
<template>
  <div class="empty-workspace">
    <section class="overview-content" aria-label="Workspace overview">
      <div class="workspace-counts">
        <div><strong>0</strong><span>Collections</span></div>
        <div><strong>0</strong><span>Environments</span></div>
      </div>
      <h2>Quick Actions</h2>
      <div class="quick-actions">
        <UiButton
          variant="soft"
          disabled
          title="Collection creation is available in milestone M2"
          ><AppIcon name="plus" />Create Collection</UiButton
        >
      </div>
      <h2>Collections</h2>
      <div class="empty-collection">
        <AppIcon name="cube" :size="30" />
        <h3>No collections yet</h3>
        <p>Your new workspace starts here.</p>
        <p class="muted">
          Collection storage and request editing arrive in M2.
        </p>
      </div>
    </section>
    <aside class="workspace-guide">
      <header><AppIcon name="file" />Getting started</header>
      <div>
        <AppIcon name="file" :size="48" />
        <p>PostMen is moving to Tauri + Vue.</p>
        <p class="muted">A fresh workspace. Familiar controls.</p>
        <ul>
          <li>Light, dark, or system theme</li>
          <li>Resizable workspace panels</li>
          <li>Native desktop window and menus</li>
        </ul>
        <UiButton variant="soft" @click="$emit('about')"
          ><AppIcon name="info" />About this milestone</UiButton
        >
      </div>
    </aside>
  </div>
</template>
