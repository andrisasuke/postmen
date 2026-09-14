<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from "vue";
import { useWorkspaceStore } from "../stores/workspace";
import { useNotificationsStore } from "../stores/notifications";
import { clone, newRow } from "../types/data";
import type { Environment, EnvironmentInput } from "../types/data";
import { errorMessage } from "../services/data";
import { environmentContent, validateEnvironment } from "../services/variables";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import UiCheckbox from "../components/ui/UiCheckbox.vue";
import IconButton from "../components/ui/IconButton.vue";
import AppIcon from "../components/ui/AppIcon.vue";
const props = defineProps<{ collectionId: string | null; initialScope: "collection" | "global" }>();
const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore();
const notifications = useNotificationsStore();
const scope = ref(props.initialScope);
const collection = ref(props.collectionId ?? store.data.collections[0]?.id ?? null);
if (!collection.value) scope.value = "global";
const scopeId = computed(() => scope.value === "collection" ? collection.value : null);
const search = ref("");
const failure = ref("");
const busy = ref(false);
const deleting = ref(false);
const pending = shallowRef<(() => void) | null>(null);
const nameInput = ref<HTMLInputElement>();
const draft = ref<EnvironmentInput | null>(null);
const baseline = ref("");
const blank = (row: Environment["variables"][number]) => !row.name && !row.value && !row.description;
const payload = () => draft.value ? { ...clone(draft.value), variables: draft.value.variables.filter(row => !blank(row)) } : null;
const dirty = computed(() => environmentContent(payload()) !== baseline.value);
const locked = computed(() => busy.value || store.environmentBusy || !!pending.value || deleting.value);
const environments = computed(() => store.data.environments.filter(e => e.collectionId === scopeId.value && e.name.toLowerCase().includes(search.value.toLowerCase())).sort((a,b) => a.name.localeCompare(b.name)));
const selected = computed(() => store.selectedEnvironment(scopeId.value));
function load(environment?: Environment) {
  draft.value = environment ? { ...clone(environment) } : null;
  baseline.value = environmentContent(payload());
  if (draft.value && draft.value.variables.length < 500) draft.value.variables.push(newRow());
  failure.value = ""; deleting.value = false;
}
function loadFirst() {
  search.value = "";
  load(store.selectedEnvironment(scopeId.value) ?? store.data.environments.find(e => e.collectionId === scopeId.value));
}
loadFirst();
function navigate(action: () => void) {
  if (busy.value || store.environmentBusy || pending.value) return;
  if (dirty.value) pending.value = action;
  else action();
}
function close() { navigate(() => emit("close")); }
function create(copy = false) {
  const source = copy ? payload() : null;
  navigate(() => {
    draft.value = { id: null, collectionId: scopeId.value, name: source ? `${source.name} copy` : "Untitled Environment", revision: null,
      variables: source ? source.variables.map(v => ({ ...v, id: crypto.randomUUID() })) : [] };
    baseline.value = "null";
    if (draft.value.variables.length < 500) draft.value.variables.push(newRow());
    failure.value = "";
    void nextTick(() => { nameInput.value?.focus(); nameInput.value?.select(); });
  });
}
function grow() {
  if (draft.value && draft.value.variables.length < 500 && !draft.value.variables.some(blank)) draft.value.variables.push(newRow());
}
async function save(): Promise<boolean> {
  const input = payload();
  if (!input || busy.value || store.environmentBusy) return false;
  if (!dirty.value) return true;
  failure.value = "";
  try {
    validateEnvironment(input); busy.value = true;
    load(await store.saveEnvironment(input));
    return true;
  } catch (error) {
    failure.value = errorMessage(error);
    if (!busy.value) notifications.error("Failed to save environment. Check the name and variables.");
    return false;
  }
  finally { busy.value = false; }
}
async function proceed(saveFirst: boolean) {
  const next = pending.value;
  if (saveFirst && !await save()) return;
  pending.value = null;
  next?.();
}
function reset() {
  if (!draft.value?.id) load();
  else load(store.data.environments.find(e => e.id === draft.value?.id));
}
async function remove() {
  if (!draft.value?.id || busy.value) return;
  busy.value = true; failure.value = "";
  try { await store.deleteEnvironment(draft.value.id); loadFirst(); }
  catch (error) { failure.value = errorMessage(error); }
  finally { busy.value = false; }
}
async function activate() {
  if (!draft.value?.id) return;
  failure.value = "";
  try { await store.selectEnvironment(scopeId.value, selected.value?.id === draft.value.id ? null : draft.value.id); }
  catch (error) { failure.value = errorMessage(error); }
}
function shortcuts(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault(); event.stopPropagation();
    if (!locked.value) void save();
  }
}
</script>
<template>
  <UiModal :open="true" title="Environments" panel-class="environment-manager-dialog" :busy="busy || store.environmentBusy" @close="close">
    <div class="environment-manager" @keydown="shortcuts">
      <aside class="environment-sidebar">
        <div class="environment-sidebar-heading"><strong>ENVIRONMENTS</strong><span class="spacer" /><IconButton label="Create environment" icon="plus" :disabled="locked || (scope === 'collection' && !collection)" @click="create()" /></div>
        <div class="environment-scope-tabs">
          <button type="button" :class="{ active: scope === 'collection' }" :aria-pressed="scope === 'collection'" :disabled="locked || !store.data.collections.length" @click="navigate(() => { scope = 'collection'; loadFirst(); })">Collection</button>
          <button type="button" :class="{ active: scope === 'global' }" :aria-pressed="scope === 'global'" :disabled="locked" @click="navigate(() => { scope = 'global'; loadFirst(); })">Global</button>
        </div>
        <UiSelect v-if="scope === 'collection'" :model-value="collection" label="Environment collection" :options="store.data.collections.map(c => ({ value: c.id, label: c.name }))" :disabled="locked" @update:model-value="navigate(() => { collection = $event; loadFirst(); })" />
        <div class="environment-search"><AppIcon name="search" /><input v-model="search" placeholder="Search environments..." aria-label="Search managed environments" :disabled="locked" /></div>
        <div class="environment-sidebar-list">
          <button v-for="env in environments" :key="env.id" type="button" :class="{ active: env.id === draft?.id }" :disabled="locked" :aria-current="env.id === draft?.id ? 'true' : undefined" @click="navigate(() => load(store.data.environments.find(item => item.id === env.id)))"><span>{{ env.name }}</span><AppIcon v-if="selected?.id === env.id" name="check" class="environment-active-check" /></button>
          <p v-if="!environments.length" class="muted">{{ search ? 'No matching environments' : 'No environments yet' }}</p>
        </div>
      </aside>
      <section class="environment-editor" aria-label="Environment variables">
        <template v-if="draft">
          <header class="environment-editor-heading">
            <input ref="nameInput" v-model="draft.name" aria-label="Environment name" maxlength="200" :disabled="locked" spellcheck="false" /><span v-if="dirty" class="dirty-dot" aria-label="Unsaved environment changes">●</span><span class="spacer" />
            <IconButton :label="selected?.id === draft.id ? 'Deselect environment' : 'Use environment'" icon="check" :active="selected?.id === draft.id" :disabled="locked || !draft.id || dirty" @click="activate" />
            <IconButton label="Save environment" icon="save" :disabled="locked || !dirty" @click="save" />
            <IconButton label="Rename environment" icon="pencil" :disabled="locked" @click="nameInput?.focus(); nameInput?.select()" />
            <IconButton label="Duplicate environment" icon="copy" :disabled="locked" @click="create(true)" />
            <IconButton label="Delete environment" icon="trash" :disabled="locked || !draft.id" @click="deleting = true" />
          </header>
          <div class="environment-editor-tabs"><span>Variables <sup>{{ draft.variables.filter(v => !blank(v)).length }}</sup></span></div>
          <div class="environment-table-scroll">
            <table class="environment-variable-table" aria-label="Environment variables">
              <colgroup><col style="width:32px" /><col style="width:24%" /><col style="width:40%" /><col /><col style="width:34px" /></colgroup>
              <thead><tr><th aria-label="Enabled" /><th>Name</th><th>Value</th><th>Description</th><th aria-label="Delete variable" /></tr></thead>
              <tbody><tr v-for="(variable,index) in draft.variables" :key="variable.id">
                <td><UiCheckbox v-if="!blank(variable)" v-model="variable.enabled" :label="`Enable variable ${index + 1}`" :disabled="locked" /></td>
                <td><input v-model="variable.name" :aria-label="`Variable name ${index + 1}`" placeholder="Name" spellcheck="false" maxlength="200" :disabled="locked" @input="grow" /></td>
                <td><div class="environment-variable-value"><input v-model="variable.value" :aria-label="`Variable value ${index + 1}`" placeholder="Value" spellcheck="false" :disabled="locked" @input="grow" /><span v-if="!blank(variable)" class="muted">string</span></div></td>
                <td><input v-model="variable.description" :aria-label="`Variable description ${index + 1}`" placeholder="Description" :disabled="locked" @input="grow" /></td>
                <td><IconButton v-if="!blank(variable)" :label="`Delete variable ${index + 1}`" icon="trash" :disabled="locked" @click="draft.variables.splice(index,1); grow()" /></td>
              </tr></tbody>
            </table>
          </div>
          <div class="environment-editor-actions"><UiButton variant="primary" :disabled="locked || !dirty" @click="save">{{ busy ? 'Saving…' : 'Save' }}</UiButton><UiButton variant="ghost" :disabled="locked || !dirty" @click="reset">Reset</UiButton></div>
          <p class="environment-usage muted">Use <code>&lt;&lt;variable_name&gt;&gt;</code> in URL, parameters and headers. Disabled variables are not used.</p>
        </template>
        <div v-else class="environment-editor-empty"><AppIcon name="database" :size="36" /><p>Select or create an environment.</p><UiButton variant="primary" :disabled="locked" @click="create()">Create environment</UiButton></div>
        <div v-if="deleting" class="environment-confirm" role="alert"><p>Delete “{{ draft?.name }}” and its variables?</p><UiButton variant="danger" :disabled="busy" @click="remove">Delete</UiButton><UiButton :disabled="busy" @click="deleting = false">Cancel</UiButton></div>
        <div v-if="pending" class="environment-confirm" role="alert"><p>Save changes to “{{ draft?.name }}” before continuing?</p><UiButton variant="primary" :disabled="busy" @click="proceed(true)">Save changes</UiButton><UiButton :disabled="busy" @click="proceed(false)">Discard changes</UiButton><UiButton :disabled="busy" @click="pending = null">Cancel</UiButton></div>
        <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
      </section>
    </div>
  </UiModal>
</template>
<style>
.environment-manager-dialog { width: min(1280px, calc(100vw - 32px)); display: flex; flex-direction: column; max-height: calc(100dvh - 66px); }
.environment-manager-dialog .modal-body { padding: 0; min-height: 0; overflow: auto; }
.environment-manager { display: flex; min-height: min(540px, calc(100dvh - 110px)); background: var(--bg); }
.environment-sidebar { width: 210px; flex: 0 0 210px; border-right: 1px solid var(--border); padding: 12px 8px; }
.environment-sidebar-heading { display: flex; align-items: center; padding: 0 8px; font-size: 11px; }
.environment-sidebar .environment-scope-tabs { padding: 0 8px; gap: 16px; }
.environment-sidebar .ui-select-trigger { width: calc(100% - 12px); margin: 8px 6px 0; }
.environment-sidebar .environment-search { margin: 12px 2px; font-size: 12px; }
.environment-sidebar-list { display: flex; flex-direction: column; gap: 4px; }
.environment-sidebar-list > button { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 6px; text-align: left; }
.environment-sidebar-list > button > span { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.environment-sidebar-list > button:hover, .environment-sidebar-list > button.active { background: var(--hover); }
.environment-sidebar-list > p { padding: 12px; font-size: 12px; }
.environment-active-check { color: var(--get); }
.environment-editor { flex: 1; min-width: 0; padding: 12px 18px; }
.environment-editor-heading { display: flex; align-items: center; gap: 6px; }
.environment-editor-heading > input { min-width: 0; width: min(280px, 45%); border: 0; padding: 4px 0; font-weight: 600; background: transparent; }
.environment-editor-tabs { margin: 20px 0 14px; border-bottom: 1px solid var(--border-subtle); }
.environment-editor-tabs > span { display: inline-block; padding: 0 0 12px; border-bottom: 2px solid var(--primary); }
.environment-editor-tabs sup { color: var(--muted); font-size: 10px; }
.environment-table-scroll { overflow: auto; border: 1px solid var(--border); border-radius: 7px; }
.environment-variable-table { border-collapse: collapse; table-layout: fixed; width: 100%; min-width: 520px; }
.environment-variable-table th { text-align: left; font-weight: 500; padding: 8px; }
.environment-variable-table td { height: 38px; border-top: 1px solid var(--border); padding: 0 8px; }
.environment-variable-table td:not(:first-child):not(:nth-child(2)), .environment-variable-table th:not(:first-child):not(:nth-child(2)) { border-left: 1px solid var(--border); }
.environment-variable-table input:not([type="checkbox"]) { width: 100%; min-width: 0; border: 0; background: transparent; padding: 7px 0; }
.environment-variable-value { display: flex; align-items: center; gap: 8px; }
.environment-variable-value > span { font-size: 11px; }
.environment-editor-actions { display: flex; gap: 12px; margin-top: 14px; }
.environment-editor-actions .button-ghost { color: var(--primary-text); }
.environment-usage { margin-top: 16px; font-size: 11px; }
.environment-editor-empty { min-height: 280px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 16px; }
.environment-confirm { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; padding: 12px; border: 1px solid var(--border-strong); border-radius: 6px; }
.environment-confirm p { flex-basis: 100%; overflow-wrap: anywhere; }
@media (max-width: 760px) { .environment-sidebar { width: 170px; flex-basis: 170px; } .environment-editor { padding: 10px; } .environment-editor-heading { flex-wrap: wrap; } .environment-editor-heading > input { width: 100%; flex-basis: 100%; } }
</style>
