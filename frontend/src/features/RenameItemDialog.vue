<script setup lang="ts">
import { computed, onMounted, ref, useId } from "vue";
import type { TreeRef } from "../types/data";
import { useWorkspaceStore } from "../stores/workspace";
import { useNotificationsStore } from "../stores/notifications";
import { errorMessage } from "../services/data";
import { hasControlCharacters } from "../services/curl-import";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";

const props = defineProps<{ item: TreeRef; initialName: string }>();
const emit = defineEmits<{ close: []; renamed: [] }>();
const store = useWorkspaceStore();
const notifications = useNotificationsStore();
const kind = computed(() => props.item.kind === "request" ? "Request" : "Folder");
const formId = useId();
const name = ref(props.initialName);
const field = ref<HTMLInputElement>();
const busy = ref(false);
const failure = ref("");
onMounted(() => field.value?.select());

function close() { if (!busy.value) emit("close"); }
async function submit() {
  if (busy.value) return;
  failure.value = "";
  const trimmed = name.value.trim();
  if (!trimmed || [...trimmed].length > 200 || hasControlCharacters(trimmed)) {
    failure.value = `Enter a ${props.item.kind} name (1–200 characters, without control characters).`;
    notifications.error(`Failed to rename ${props.item.kind}. Check the name.`);
    return;
  }
  busy.value = true;
  try {
    await store.rename(props.item, trimmed);
    emit("renamed");
  } catch (error) { failure.value = errorMessage(error); }
  finally { busy.value = false; }
}
</script>

<template>
  <UiModal :open="true" :title="`Rename ${kind}`" panel-class="rename-item-dialog" :busy="busy" @close="close">
    <form :id="formId" class="rename-item-form" autocomplete="off" @submit.prevent="submit">
      <label :for="`${formId}-name`">{{ kind }} Name</label>
      <input :id="`${formId}-name`" ref="field" v-model="name" class="ui-input" maxlength="200"
        :disabled="busy" :aria-invalid="!!failure" :aria-describedby="failure ? `${formId}-error` : undefined"
        spellcheck="false" data-autofocus />
      <p v-if="failure" :id="`${formId}-error`" class="inline-error" role="alert">{{ failure }}</p>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton type="submit" :form="formId" variant="primary" :disabled="busy">{{ busy ? 'Renaming…' : 'Rename' }}</UiButton>
    </template>
  </UiModal>
</template>

<style>
.rename-item-dialog { display: flex; flex-direction: column; max-height: calc(100dvh - 66px); }
.rename-item-dialog .modal-header, .rename-item-dialog .modal-footer { flex-shrink: 0; }
.rename-item-dialog .modal-body { min-height: 0; overflow-y: auto; }
.rename-item-form { display: flex; flex-direction: column; gap: 10px; }
.rename-item-form > label { font-size: 13px; font-weight: 600; }
.rename-item-form > .ui-input { height: 34px; border-radius: 6px; border-color: var(--border-strong); font-size: 13px; }
.rename-item-dialog .modal-footer .ui-button { height: 30px; min-width: 72px; }
</style>
