<script setup lang="ts">
import { ref, useId } from "vue";
import type { Parent } from "../types/data";
import { useWorkspaceStore } from "../stores/workspace";
import { useNotificationsStore } from "../stores/notifications";
import { errorMessage } from "../services/data";
import { hasControlCharacters } from "../services/curl-import";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";

const props = defineProps<{ parent: Parent }>();
const emit = defineEmits<{ close: []; created: [] }>();
const store = useWorkspaceStore();
const notifications = useNotificationsStore();
const formId = useId();
const name = ref("");
const busy = ref(false);
const failure = ref("");

function close() {
  if (!busy.value) emit("close");
}
async function submit() {
  if (busy.value) return;
  failure.value = "";
  const trimmed = name.value.trim();
  if (!trimmed || [...trimmed].length > 200 || hasControlCharacters(trimmed)) {
    failure.value = "Enter a folder name (1–200 characters, without control characters).";
    notifications.error("Failed to create folder. Check the name.");
    return;
  }
  busy.value = true;
  try {
    await store.createFolder(props.parent, trimmed);
    emit("created");
  } catch (error) {
    failure.value = errorMessage(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal :open="true" title="New Folder" panel-class="new-folder-dialog" :busy="busy" @close="close">
    <form :id="formId" class="new-folder-form" autocomplete="off" @submit.prevent="submit">
      <label :for="`${formId}-name`">Folder Name</label>
      <input
        :id="`${formId}-name`"
        v-model="name"
        class="ui-input"
        maxlength="200"
        :disabled="busy"
        :aria-invalid="!!failure"
        :aria-describedby="failure ? `${formId}-error` : undefined"
        spellcheck="false"
        data-autofocus
      />
      <p v-if="failure" :id="`${formId}-error`" class="inline-error" role="alert">{{ failure }}</p>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton type="submit" :form="formId" variant="primary" :disabled="busy">{{ busy ? 'Creating…' : 'Create' }}</UiButton>
    </template>
  </UiModal>
</template>

<style>
.new-folder-dialog { display: flex; flex-direction: column; max-height: calc(100dvh - 66px); }
.new-folder-dialog .modal-header, .new-folder-dialog .modal-footer { flex-shrink: 0; }
.new-folder-dialog .modal-body { min-height: 0; overflow-y: auto; }
.new-folder-form { display: flex; flex-direction: column; gap: 10px; }
.new-folder-form > label { font-size: 13px; font-weight: 600; }
.new-folder-form > .ui-input { height: 34px; border-radius: 6px; border-color: var(--border-strong); font-size: 13px; }
.new-folder-dialog .modal-footer { padding-top: 16px; }
.new-folder-dialog .modal-footer .ui-button { height: 30px; min-width: 72px; }
</style>
