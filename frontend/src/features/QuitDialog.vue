<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useWorkspaceStore } from "../stores/workspace";
import { useExecutionStore } from "../stores/execution";
import { useSettingsStore } from "../stores/settings";
import { finishQuit, cancelQuit } from "../services/execution";
import { isDesktop } from "../services/desktop";
import { errorMessage } from "../services/data";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; finished: [] }>();
const store = useWorkspaceStore();
const executions = useExecutionStore();
const settings = useSettingsStore();
const busy = ref(false);
const failure = ref("");
const stateFailure = ref(false);
const saving = computed(
  () => store.loading || Object.values(store.tabs).some((t) => t.saving),
);
watch(
  () => props.open,
  (open) => {
    if (open) {
      failure.value = "";
      stateFailure.value = false;
    }
  },
);
async function cancel() {
  if (busy.value) return;
  try {
    if (isDesktop()) await cancelQuit();
    emit("close");
  } catch (e) {
    failure.value = errorMessage(e);
  }
}
async function quit(save: boolean, skipState = false) {
  if (busy.value || saving.value) return;
  busy.value = true;
  failure.value = "";
  stateFailure.value = false;
  try {
    if (save) {
      for (const id of [...store.dirtyIds]) {
        if (!(await store.save(id)))
          throw new Error(
            "A draft changed during save. Review it and try again.",
          );
      }
      if (store.hasDirty) throw new Error("There are still unsaved drafts.");
    }
    // Discard is deferred until successful exit: a persistence error must not
    // destroy drafts while the user is still deciding whether to stay.
    await executions.cancelAll();
    if (!skipState) {
      const preferencesSaved = settings.persistPreferences();
      if (!(await store.persistSession()) || !preferencesSaved) {
        stateFailure.value = true;
        throw new Error(
          "Tab or preference state could not be saved. Retry, cancel, or explicitly quit without saving session/window state.",
        );
      }
    }
    try {
      if (isDesktop()) await finishQuit(skipState);
      else emit("finished");
    } catch (e) {
      stateFailure.value = true;
      throw e;
    }
  } catch (e) {
    failure.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <UiModal :open="open" title="Quit PostMen" @close="cancel"
    ><p v-if="store.hasDirty">
      Save changes to these requests before quitting?
    </p>
    <p v-else>
      Quit PostMen? Saved requests and tabs will be restored next time.
    </p>
    <ul v-if="store.hasDirty" class="quit-drafts">
      <li v-for="id in store.dirtyIds" :key="id">
        {{ store.tabs[id]?.draft.name }}
      </li>
    </ul>
    <p v-if="executions.activeIds.length" class="muted">
      {{ executions.activeIds.length }} active request(s) will be cancelled. The
      server may already have processed them.
    </p>
    <p v-if="saving" class="muted">Wait for current saves to finish.</p>
    <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
    <template #footer
      ><UiButton data-autofocus :disabled="busy" @click="cancel"
        >Cancel</UiButton
      ><UiButton
        v-if="stateFailure"
        variant="danger"
        :disabled="busy || saving"
        @click="quit(false, true)"
        >{{
          store.hasDirty
            ? "Discard and Quit without saving state"
            : "Quit without saving state"
        }}</UiButton
      ><UiButton
        v-if="store.hasDirty"
        variant="danger"
        :disabled="busy || saving"
        @click="quit(false)"
        >Discard and Quit</UiButton
      ><UiButton
        variant="primary"
        :disabled="busy || saving"
        @click="quit(true)"
        >{{
          busy ? "Finishing…" : store.hasDirty ? "Save All and Quit" : "Quit"
        }}</UiButton
      ></template
    ></UiModal
  >
</template>
