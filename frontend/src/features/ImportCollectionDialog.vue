<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { collectionImport, type ImportConflict, type ImportMode, type ImportPreview } from "../services/collection-import";
import { DataError, errorMessage } from "../services/data";
import { isDesktop } from "../services/desktop";
import { useWorkspaceStore } from "../stores/workspace";
import { useExecutionStore } from "../stores/execution";
import { useNotificationsStore } from "../stores/notifications";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import AppIcon from "../components/ui/AppIcon.vue";

const emit = defineEmits<{ close: []; imported: [id: string] }>();
const store = useWorkspaceStore();
const executions = useExecutionStore();
const notifications = useNotificationsStore();
const inputId = useId();
const native = isDesktop();
const busy = ref(false);
const dragging = ref(false);
const failure = ref("");
const preview = ref<ImportPreview | null>(null);
const conflicts = ref<ImportConflict[]>([]);
const mode = ref<"copy" | "overwrite">("copy");
const targetId = ref<string | null>(null);
let disposed = false;
const targetOptions = computed(() => conflicts.value.map((item, index) => ({
  value: item.id,
  label: `${item.name} — ${item.requestCount} requests${conflicts.value.length > 1 ? ` (match ${index + 1}, ${item.id.slice(0, 8)})` : ""}`,
})));
const overwriteBlock = computed(() => {
  if (executions.activeIds.length) return "Wait for running requests to finish, or import as a new collection.";
  if (store.environmentBusy) return "Wait for environment changes to finish.";
  const ids = targetId.value ? store.descendants({ kind: "collection", id: targetId.value }) : [];
  if (ids.some(id => store.tabs[id]?.saving || store.dirty(id)))
    return "This collection has unsaved drafts or pending saves. Cancel and save/discard them first, or import as a new collection.";
  return "";
});
function close() { if (!busy.value) emit("close"); }
function forgetPreview() {
  const token = preview.value?.token;
  preview.value = null;
  conflicts.value = [];
  targetId.value = null;
  mode.value = "copy";
  if (token) void collectionImport.discard(token).catch(() => {});
}
function report(error: unknown, message: string) {
  failure.value = errorMessage(error);
  notifications.error(message);
}
async function load(file?: File) {
  if (busy.value || !native) return;
  busy.value = true;
  failure.value = "";
  forgetPreview();
  try {
    const result = file ? await collectionImport.drop(file) : await collectionImport.pick();
    if (disposed) {
      if (result) void collectionImport.discard(result.token).catch(() => {});
    } else preview.value = result;
  } catch (error) { report(error, "Failed to read collection file"); }
  finally { busy.value = false; }
}
async function drop(event: DragEvent) {
  dragging.value = false;
  if (busy.value || !native) return;
  const files = event.dataTransfer?.files;
  if (!files || files.length !== 1) {
    forgetPreview();
    report(new DataError("INVALID_INPUT", "Drop one JSON collection file at a time."), "Failed to read collection file");
    return;
  }
  await load(files[0]);
}
function hasFiles(event: DragEvent) {
  return !!event.dataTransfer?.files.length || !!event.dataTransfer?.types?.includes("Files");
}
function preventFileNavigation(event: DragEvent) {
  if (hasFiles(event)) event.preventDefault();
}
function dropInDialog(event: DragEvent) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dragging.value = false;
  if (event.target instanceof Element && event.target.closest(".import-collection-dialog")) void drop(event);
}
async function submit() {
  if (busy.value || !preview.value) return;
  const selectedMode: ImportMode = conflicts.value.length ? mode.value : "create";
  if (selectedMode === "overwrite" && (overwriteBlock.value || !targetId.value)) return;
  busy.value = true;
  failure.value = "";
  try {
    const affected = selectedMode === "overwrite" && targetId.value
      ? store.descendants({ kind: "collection", id: targetId.value }) : [];
    const result = await collectionImport.commit(preview.value.token, selectedMode,
      selectedMode === "overwrite" ? targetId.value : null);
    if (result.status === "conflict") {
      conflicts.value = result.conflicts;
      targetId.value = result.conflicts[0]?.id ?? null;
      mode.value = "copy";
      return;
    }
    // No awaited work between the successful commit and local reconciliation.
    for (const id of affected) delete executions.states[id];
    store.applyImportedCollection(result);
    preview.value = null;
    notifications.success("Collection imported successfully");
    emit("imported", result.collectionId);
  } catch (error) { report(error, "Failed to import collection"); }
  finally { busy.value = false; }
}
onMounted(() => {
  // Cover the header/footer too; an external file must never navigate the webview.
  document.addEventListener("dragover", preventFileNavigation, true);
  document.addEventListener("drop", dropInDialog, true);
});
onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener("dragover", preventFileNavigation, true);
  document.removeEventListener("drop", dropInDialog, true);
  forgetPreview();
});
</script>

<template>
  <UiModal :open="true" title="Import Collection" panel-class="import-collection-dialog" :busy="busy" @close="close">
    <div class="collection-import-body">
      <p v-if="!native" class="inline-error" role="alert">Collection import is available in the desktop app. Start PostMen with npm run tauri:dev.</p>
      <button
        type="button" class="collection-dropzone" :class="{ dragging }" :disabled="busy || !native"
        data-autofocus @click="load()" @dragenter.prevent="dragging = true"
        @dragleave.prevent="dragging = false" @dragover.prevent="dragging = true"
      >
        <AppIcon name="upload" :size="28" />
        <strong>{{ busy ? 'Processing collection…' : 'Choose a file or drop it here' }}</strong>
        <span>Postman Collection v2.0 / v2.1 · .json · up to 10 MiB</span>
      </button>
      <section v-if="preview" class="collection-import-preview" aria-live="polite">
        <div class="import-valid"><AppIcon name="check" /><span>Valid collection</span></div>
        <strong class="import-collection-name">{{ preview.name }}</strong>
        <p>{{ preview.requestCount }} requests · {{ preview.folderCount }} folders · {{ preview.variableCount }} variables</p>
        <details v-if="preview.warnings.length" open>
          <summary>Review before importing ({{ preview.warnings.length }})</summary>
          <ul><li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li></ul>
        </details>
      </section>
      <fieldset v-if="conflicts.length" class="import-conflict" :disabled="busy">
        <legend>A collection with this name already exists</legend>
        <label><input v-model="mode" type="radio" :name="inputId" value="copy" />Add as a new collection</label>
        <p>A suffix _1, _2, … is added using the next available name. The existing collection is kept.</p>
        <label><input v-model="mode" type="radio" :name="inputId" value="overwrite" />Overwrite existing collection</label>
        <template v-if="mode === 'overwrite'">
          <UiSelect v-model="targetId" label="Collection to overwrite" :options="targetOptions" :disabled="busy" />
          <p class="inline-error">This replaces all requests, folders and collection environments in the selected collection. This cannot be undone. Other collections and global environments are kept.</p>
          <p v-if="overwriteBlock" class="inline-error" role="status">{{ overwriteBlock }}</p>
        </template>
      </fieldset>
      <p v-if="failure" class="inline-error import-diagnostic" role="alert">{{ failure }}</p>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton :variant="conflicts.length && mode === 'overwrite' ? 'danger' : 'primary'"
        :disabled="busy || !preview || (!!conflicts.length && mode === 'overwrite' && (!!overwriteBlock || !targetId))" @click="submit">
        {{ busy ? 'Processing…' : conflicts.length && mode === 'overwrite' ? 'Overwrite & Import' : 'Import' }}
      </UiButton>
    </template>
  </UiModal>
</template>

<style>
.import-collection-dialog { width: min(560px, calc(100vw - 32px)); display: flex; flex-direction: column; max-height: calc(100dvh - 66px); }
.import-collection-dialog .modal-header, .import-collection-dialog .modal-footer { flex-shrink: 0; }
.import-collection-dialog .modal-body { min-height: 0; overflow-y: auto; }
.collection-import-body { display: flex; flex-direction: column; gap: 16px; font-size: 13px; }
.collection-import-body p { margin: 0; line-height: 1.5; }
.import-diagnostic, .collection-import-preview li { white-space: pre-wrap; overflow-wrap: anywhere; }
.collection-dropzone { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 24px 16px; border: 1px dashed var(--border-strong); border-radius: 6px; color: var(--text); background: transparent; cursor: pointer; }
.collection-dropzone:hover:not(:disabled), .collection-dropzone.dragging { border-color: var(--primary); background: var(--hover); }
.collection-dropzone:disabled { cursor: default; opacity: .65; }
.collection-dropzone > span { color: var(--muted); font-size: 12px; }
.collection-dropzone > * { pointer-events: none; }
.collection-import-preview { display: flex; flex-direction: column; gap: 8px; }
.import-valid { display: flex; align-items: center; gap: 6px; color: var(--primary-text); }
.import-collection-name { overflow-wrap: anywhere; font-size: 15px; }
.collection-import-preview details { color: var(--muted); font-size: 12px; line-height: 1.5; }
.collection-import-preview summary { cursor: pointer; }
.collection-import-preview ul { margin: 8px 0 0; padding-left: 18px; }
.collection-import-preview li + li { margin-top: 6px; }
.import-conflict { min-width: 0; display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--border-strong); border-radius: 6px; }
.import-conflict legend { padding: 0 4px; font-weight: 600; }
.import-conflict > label { display: flex; align-items: center; gap: 8px; }
.import-conflict input { accent-color: var(--primary); }
.import-conflict > p { font-size: 12px; }
.import-conflict .ui-select-trigger { width: 100%; min-width: 0; }
.import-conflict .ui-select-trigger > span { overflow: hidden; text-overflow: ellipsis; }
</style>
