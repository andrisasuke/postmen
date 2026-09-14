<script setup lang="ts">
import { onMounted, ref, useId } from "vue";
import { useWorkspaceStore } from "../stores/workspace";
import { useNotificationsStore } from "../stores/notifications";
import { errorMessage } from "../services/data";
import { hasControlCharacters } from "../services/curl-import";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";

const props = defineProps<{ requestId: string; requestName: string }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();
const store = useWorkspaceStore();
const notifications = useNotificationsStore();
const formId = useId();
const name = ref(`${props.requestName} - Copy`);
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
    failure.value = "Enter a request name (1–200 characters, without control characters).";
    notifications.error("Failed to clone request. Check the name.");
    return;
  }
  busy.value = true;
  try {
    const copy = await store.cloneRequest(props.requestId, trimmed);
    emit("created", copy.id);
  } catch (error) {
    failure.value = errorMessage(error);
  } finally { busy.value = false; }
}
</script>

<template>
  <UiModal :open="true" title="Clone Request" panel-class="clone-request-dialog" :busy="busy" @close="close">
    <form :id="formId" class="clone-request-form" autocomplete="off" @submit.prevent="submit">
      <label :for="`${formId}-name`">Request Name</label>
      <input :id="`${formId}-name`" ref="field" v-model="name" class="ui-input" maxlength="200"
        :disabled="busy" :aria-invalid="!!failure" :aria-describedby="failure ? `${formId}-error` : undefined"
        spellcheck="false" data-autofocus />
      <p v-if="store.dirty(requestId)" class="muted clone-request-hint">Includes unsaved changes. The original request will not be saved or changed.</p>
      <p v-if="failure" :id="`${formId}-error`" class="inline-error" role="alert">{{ failure }}</p>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton type="submit" :form="formId" variant="primary" :disabled="busy">{{ busy ? 'Cloning…' : 'Clone' }}</UiButton>
    </template>
  </UiModal>
</template>

<style>
.clone-request-dialog { display: flex; flex-direction: column; max-height: calc(100dvh - 66px); }
.clone-request-dialog .modal-header, .clone-request-dialog .modal-footer { flex-shrink: 0; }
.clone-request-dialog .modal-body { min-height: 0; overflow-y: auto; }
.clone-request-form { display: flex; flex-direction: column; gap: 10px; }
.clone-request-form > label { font-size: 13px; font-weight: 600; }
.clone-request-form > .ui-input { height: 34px; border-radius: 6px; border-color: var(--border-strong); font-size: 13px; }
.clone-request-hint { font-size: 11px; }
.clone-request-dialog .modal-footer .ui-button { height: 30px; min-width: 72px; }
</style>
