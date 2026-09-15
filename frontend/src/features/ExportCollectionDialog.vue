<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from "vue";
import { collectionExport, type ExportPreview } from "../services/collection-export";
import { errorMessage } from "../services/data";
import { isDesktop } from "../services/desktop";
import { useWorkspaceStore } from "../stores/workspace";
import { useNotificationsStore } from "../stores/notifications";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";

const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore();
const notifications = useNotificationsStore();
const native = isDesktop();
const selected = ref<string[]>(store.activeCollectionId ? [store.activeCollectionId] : []);
const includeVariables = ref(true);
const preview = ref<ExportPreview | null>(null);
const names = ref<Record<string, string>>({});
const location = ref("");
const busy = ref(false);
const failure = ref("");
const writtenCount = ref(0);
const conflicts = ref<string[]>([]);
const form = ref<HTMLElement>();
const formId = useId();
let disposed = false;
const collections = computed(() => [...store.data.collections].sort((a,b) => a.position - b.position || a.id.localeCompare(b.id)));
const block = computed(() => {
  if (!native) return "Collection export is available in the desktop app.";
  if (!selected.value.length) return "Select at least one collection.";
  if (selected.value.length > 50) return "Select at most 50 collections per export.";
  if (store.environmentBusy) return "Wait for environment changes to finish.";
  if (selected.value.some(id => !store.data.collections.some(c => c.id === id))) return "A selected collection is no longer available. Go Back and select again.";
  if (Object.values(store.tabs).some(tab => selected.value.includes(tab.draft.collectionId) && (tab.saving || store.dirty(tab.draft.id))))
    return "Selected collections have unsaved drafts or pending saves. Cancel, save those requests, then export again.";
  return "";
});
const warningList = computed(() => [...new Set(preview.value?.files.flatMap(file => file.warnings) ?? [])]);
function close() { if (!busy.value) emit("close"); }
function report(error: unknown) {
  failure.value = errorMessage(error);
  notifications.error("Failed to export collections");
}
function forget() {
  const token = preview.value?.token;
  preview.value = null;
  if (token) void collectionExport.discard(token).catch(() => {});
}
async function prepare() {
  if (busy.value || block.value) return;
  busy.value = true; failure.value = "";
  try {
    const result = await collectionExport.prepare(selected.value, includeVariables.value);
    if (disposed) { void collectionExport.discard(result.token).catch(() => {}); return; }
    preview.value = result;
    names.value = Object.fromEntries(result.files.map(file => [file.id, file.fileName]));
    location.value = "";
  } catch (error) { report(error); }
  finally { busy.value = false; }
  await nextTick();
  form.value?.querySelector<HTMLInputElement>('[data-file-name]')?.focus();
}
async function browse() {
  if (busy.value || !preview.value) return;
  busy.value = true; failure.value = "";
  try {
    const directory = await collectionExport.pickDirectory(preview.value.token);
    if (!disposed && directory !== null) location.value = directory;
  } catch (error) { report(error); }
  finally { busy.value = false; }
}
async function submit(overwrite = false) {
  if (busy.value || block.value || !preview.value || !location.value || preview.value.files.some(file => !names.value[file.id]?.trim())) return;
  busy.value = true; failure.value = "";
  try {
    const result = await collectionExport.commit(preview.value.token, preview.value.files.map(file => ({ id: file.id, name: names.value[file.id]! })), overwrite);
    if (result.status === "conflict") {
      conflicts.value = result.files;
      void nextTick(() => form.value?.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('[data-export-no]')?.focus());
      return;
    }
    conflicts.value = [];
    writtenCount.value += result.written.length;
    if (result.written.length) notifications.success(`${result.written.length} collection${result.written.length === 1 ? '' : 's'} exported successfully`);
    if (!result.failed.length) { preview.value = null; emit("close"); return; }
    const previous = preview.value.files;
    failure.value = result.failed.map(item => `${previous.find(file => file.id === item.id)?.name ?? 'Collection'}: ${item.message}`).join("\n");
    preview.value.files = previous.filter(file => !result.written.includes(file.id));
    notifications.error("Some collections could not be exported. Successfully exported files were kept.");
  } catch (error) { report(error); }
  finally { busy.value = false; }
}
async function back() {
  if (busy.value) return;
  forget(); failure.value = ""; location.value = ""; conflicts.value = [];
  await nextTick(); form.value?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
}
onBeforeUnmount(() => { disposed = true; forget(); });
</script>

<template>
  <UiModal :open="true" :title="preview ? 'Export to Postman' : 'Export Collections'" panel-class="export-collection-dialog" :busy="busy" @close="close">
    <form :id="formId" ref="form" class="collection-export-body" @submit.prevent="conflicts.length ? undefined : preview ? submit() : prepare()">
      <template v-if="!preview">
        <p>Select the collections to export. Each collection is saved as a separate Postman v2.1 JSON file.</p>
        <label class="export-check"><input type="checkbox" class="ui-checkbox" data-autofocus :checked="!!collections.length && selected.length === collections.length" :disabled="busy || !native || !collections.length || collections.length > 50"
          @change="selected = ($event.target as HTMLInputElement).checked ? collections.map(c => c.id) : []" />Select all</label>
        <div class="export-collection-list" role="group" aria-label="Collections to export">
          <label v-for="collection in collections" :key="collection.id" class="export-check">
            <input v-model="selected" type="checkbox" class="ui-checkbox" :value="collection.id" :disabled="busy || !native" :aria-label="`Export ${collection.name}`" />
            <span>{{ collection.name }}</span>
          </label>
          <p v-if="!collections.length">No collections available.</p>
        </div>
        <label class="export-check"><input v-model="includeVariables" type="checkbox" class="ui-checkbox" :disabled="busy || !native" />Include variables from selected Collection + Global environments</label>
        <p class="muted">Only saved requests are exported. Files may contain credentials from URLs, headers, bodies and included environment values. Review before sharing.</p>
      </template>
      <template v-else>
        <label v-for="file in preview.files" :key="file.id" class="export-field">
          <span>{{ preview.files.length === 1 ? 'Name' : file.name }}</span>
          <div class="export-filename"><input v-model="names[file.id]" data-file-name class="ui-input" :aria-label="`File name for ${file.name}`" :disabled="busy || !!conflicts.length" autocomplete="off" spellcheck="false" /><span>.json</span></div>
        </label>
        <label class="export-field"><span>Location</span><input class="ui-input" :value="location" aria-label="Export location" placeholder="Choose a folder" readonly :disabled="busy" /></label>
        <button type="button" class="export-browse" :disabled="busy || !!conflicts.length" @click="browse">Browse</button>
        <p class="muted">{{ preview.files.length }} JSON file{{ preview.files.length === 1 ? '' : 's' }} · Replacing existing files requires confirmation.</p>
        <details v-if="warningList.length"><summary>Export notes</summary><ul><li v-for="warning in warningList" :key="warning">{{ warning }}</li></ul></details>
      </template>
      <p v-if="writtenCount" role="status">{{ writtenCount }} file(s) already exported. Those files are kept.</p>
      <p v-if="block" class="inline-error" role="status">{{ block }}</p>
      <p v-if="failure" class="inline-error export-diagnostic" role="alert">{{ failure }}</p>
      <section v-if="conflicts.length" class="export-overwrite" role="alert">
        <strong>Replace existing files?</strong>
        <p>These files already exist in the selected folder. Their contents will be permanently replaced. This cannot be undone.</p>
        <ul><li v-for="file in conflicts" :key="file">{{ file }}</li></ul>
      </section>
    </form>
    <template #footer>
      <template v-if="conflicts.length">
        <UiButton data-export-no variant="ghost" :disabled="busy" @click="conflicts = []">No</UiButton>
        <UiButton variant="danger" :disabled="busy || !!block" @click="submit(true)">{{ busy ? 'Processing…' : 'Yes, overwrite' }}</UiButton>
      </template>
      <template v-else>
      <UiButton v-if="preview" variant="ghost" :disabled="busy" @click="back">Back</UiButton>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton type="submit" :form="formId" variant="primary" :disabled="busy || !!block || (!!preview && (!location || preview.files.some(file => !names[file.id]?.trim())))">
        {{ busy ? 'Processing…' : preview ? 'Export' : 'Next' }}
      </UiButton>
      </template>
    </template>
  </UiModal>
</template>

<style>
.export-collection-dialog { width: min(560px, calc(100vw - 32px)); display: flex; flex-direction: column; max-height: calc(100dvh - 66px); }
.export-collection-dialog .modal-body { min-height: 0; overflow-y: auto; }
.export-collection-dialog .modal-header, .export-collection-dialog .modal-footer { flex-shrink: 0; }
.collection-export-body { display: flex; flex-direction: column; gap: 16px; font-size: 13px; }
.collection-export-body p { margin: 0; line-height: 1.5; }
.export-check { display: flex; align-items: center; gap: 10px; line-height: 1.5; }
.export-check > span { overflow-wrap: anywhere; min-width: 0; }
.export-collection-list { display: flex; flex-direction: column; gap: 12px; max-height: 230px; overflow-y: auto; padding: 12px; border: 1px solid var(--border); border-radius: 6px; }
.export-field { display: flex; flex-direction: column; gap: 10px; font-weight: 500; }
.export-field > .ui-input, .export-filename { height: 36px; width: 100%; }
.export-filename { display: flex; align-items: center; border: 1px solid var(--border-strong); border-radius: 5px; }
.export-filename:focus-within { border-color: var(--primary); }
.export-filename .ui-input { flex: 1; width: 0; border: 0; background: transparent; outline: none; box-shadow: none; }
.export-filename > span { padding-right: 10px; color: var(--muted); font-weight: 400; }
.export-browse { align-self: flex-start; color: var(--primary-text); background: transparent; border: 0; padding: 0; cursor: pointer; }
.export-browse:disabled { opacity: .5; cursor: default; }
.collection-export-body details { font-size: 12px; color: var(--muted); line-height: 1.5; }
.collection-export-body summary { cursor: pointer; }
.collection-export-body li, .export-diagnostic { white-space: pre-wrap; overflow-wrap: anywhere; }
.export-overwrite { padding: 12px; display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--delete); border-radius: 6px; }
</style>
