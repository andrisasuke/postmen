<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { useWorkspacesStore } from "../stores/workspaces";
import AppIcon from "../components/ui/AppIcon.vue";
const workspaces = useWorkspacesStore();
const emit = defineEmits<{ save: []; cancel: [] }>();
const field = ref<HTMLInputElement>();
onMounted(() => { field.value?.focus(); field.value?.select(); });
watch(() => workspaces.busy, async busy => {
  if (!busy && workspaces.creating && !workspaces.needsRecovery) {
    await nextTick();
    field.value?.focus();
  }
});
</script>
<template>
  <form class="workspace-name-form" :aria-busy="workspaces.busy" @submit.prevent="emit('save')">
    <input
      ref="field"
      v-model="workspaces.draftName"
      class="ui-input"
      aria-label="Workspace name"
      :aria-invalid="!!workspaces.failure"
      :aria-describedby="workspaces.failure ? 'workspace-name-error' : undefined"
      :disabled="workspaces.busy"
      maxlength="200"
      autocomplete="off"
      spellcheck="false"
      @keydown.esc.prevent="emit('cancel')"
    />
    <button class="tree-form-action tree-form-confirm" type="submit" aria-label="Create workspace" title="Create workspace" :disabled="workspaces.busy">
      <AppIcon name="check" :size="22" :stroke="2" />
    </button>
    <button class="tree-form-action tree-form-cancel" type="button" aria-label="Cancel workspace creation" title="Cancel" :disabled="workspaces.busy" @click="emit('cancel')">
      <AppIcon name="x" :size="22" :stroke="2" />
    </button>
  </form>
</template>
