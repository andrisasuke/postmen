<script setup lang="ts">
import { computed, ref, useId } from "vue";
import type { Parent } from "../types/data";
import { methods, type HttpMethod } from "../types/shell";
import { useWorkspaceStore } from "../stores/workspace";
import { useNotificationsStore } from "../stores/notifications";
import { errorMessage } from "../services/data";
import { CurlImportError, emptyRequestContent, hasControlCharacters, parseCurl, validateRequestUrl } from "../services/curl-import";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import VariableInput from "../components/editor/VariableInput.vue";
import { variableName } from "../services/variables";

const props = defineProps<{ parent: Parent }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();
const store = useWorkspaceStore();
const notifications = useNotificationsStore();
const formId = useId();
const type = ref<"http" | "curl">("http");
const name = ref("");
const method = ref<HttpMethod>("GET");
const url = ref("");
const command = ref("");
const busy = ref(false);
const failure = ref("");
const imported = computed(() => {
  if (type.value !== "curl" || !command.value.trim()) return null;
  try { return { ...parseCurl(command.value), error: "" }; }
  catch (error) { return { content: null, warnings: [], error: error instanceof CurlImportError ? error.message : "Could not parse this cURL command." }; }
});
function close() { if (!busy.value) emit("close"); }
async function submit() {
  if (busy.value) return;
  failure.value = "";
  const trimmed = name.value.trim();
  if (!trimmed || [...trimmed].length > 200 || hasControlCharacters(trimmed)) {
    failure.value = "Enter a request name (1–200 characters, without control characters).";
    notifications.error("Failed to create request. Check the form.");
    return;
  }
  try {
    let content = emptyRequestContent();
    if (type.value === "curl") {
      if (!imported.value?.content) {
        failure.value = imported.value?.error || "Paste a cURL command to import.";
        notifications.error("Failed to import cURL. Check the command.");
        return;
      }
      content = imported.value.content;
    } else {
      content.method = method.value;
      if (url.value.includes("<<")) {
        const rest = url.value.replace(/<<([^<>]*)>>/g, (_token, name: string) => {
          if (!variableName.test(name)) throw new CurlImportError("Use a placeholder such as <<api_url>>.");
          return "variable";
        });
        if (rest.includes("<<") || rest.includes(">>") || hasControlCharacters(url.value) || new TextEncoder().encode(url.value).length > 8192)
          throw new CurlImportError("Enter a URL template with complete <<variable>> placeholders (maximum 8192 bytes).");
        content.url = url.value.trim();
      } else content.url = validateRequestUrl(url.value);
    }
    busy.value = true;
    const request = await store.createRequest(props.parent, trimmed, content);
    emit("created", request.id);
  } catch (error) {
    failure.value = error instanceof CurlImportError ? error.message : errorMessage(error);
    // Store mutations already notify on persistence errors; only report local validation here.
    if (!busy.value) notifications.error("Failed to create request. Check the form.");
  } finally { busy.value = false; }
}
</script>

<template>
  <UiModal :open="true" title="New Request" panel-class="new-request-dialog" :busy="busy" @close="close">
    <form :id="formId" class="new-request-form" autocomplete="off" @submit.prevent="submit">
      <div class="request-type" role="radiogroup" :aria-labelledby="`${formId}-type-label`">
        <span :id="`${formId}-type-label`" class="request-type-label">Type</span>
        <div class="request-types">
          <label><input v-model="type" :name="`${formId}-type`" type="radio" value="http" :disabled="busy" data-autofocus @change="failure = ''" />HTTP</label>
          <label><input v-model="type" :name="`${formId}-type`" type="radio" value="curl" :disabled="busy" @change="failure = ''" />From cURL</label>
        </div>
      </div>
      <div class="new-request-field">
        <label :for="`${formId}-name`">Request Name</label>
        <input :id="`${formId}-name`" v-model="name" class="ui-input" aria-label="Request Name" placeholder="Request Name" maxlength="200" :disabled="busy" spellcheck="false" />
      </div>
      <div v-if="type === 'http'" class="new-request-field">
        <label :for="`${formId}-url`">URL</label>
        <div class="new-request-url">
          <UiSelect v-model="method" label="Request method" :options="methods.map(value => ({ value, label: value }))" :disabled="busy" :style="{ color: `var(--${method.toLowerCase()})` }" />
          <VariableInput :id="`${formId}-url`" v-model="url" label="Request URL" placeholder="Request URL" :variables="store.variablesFor(parent.collectionId)" :disabled="busy" maxlength="8192" />
        </div>
      </div>
      <div v-else class="new-request-field">
        <label :for="`${formId}-curl`">cURL Command</label>
        <textarea :id="`${formId}-curl`" v-model="command" class="ui-input curl-command" placeholder="curl 'https://api.example.com/users'" :disabled="busy" :maxlength="1024 * 1024" rows="5" spellcheck="false" autocapitalize="off" :aria-describedby="`${formId}-hint`" />
        <p :id="`${formId}-hint`" class="muted import-hint">Import only — this command is never executed. Supports HTTP(S), headers, inline body and text form fields.</p>
        <div v-if="imported?.content" class="curl-preview" aria-live="polite">
          <strong :style="{ color: `var(--${imported.content.method.toLowerCase()})` }">{{ imported.content.method }}</strong>
          <span>{{ imported.content.url }}</span>
          <small>{{ imported.content.params.length }} params · {{ imported.content.headers.length }} headers · {{ imported.content.bodyKind === 'none' ? 'No body' : imported.content.bodyKind === 'multipart' ? 'Multipart text fields' : 'Inline body' }}</small>
        </div>
        <p v-if="imported?.error" class="inline-error" role="status">{{ imported.error }}</p>
        <p v-for="warning in imported?.warnings ?? []" :key="warning" class="import-hint">{{ warning }}</p>
      </div>
      <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton type="submit" :form="formId" variant="primary" :disabled="busy">{{ busy ? 'Creating…' : 'Create' }}</UiButton>
    </template>
  </UiModal>
</template>

<style>
.new-request-dialog { display: flex; flex-direction: column; max-height: calc(100dvh - 66px); }
.new-request-dialog .modal-header, .new-request-dialog .modal-footer { flex-shrink: 0; }
.new-request-dialog .modal-body { min-height: 0; overflow-y: auto; }
.new-request-form { display: flex; flex-direction: column; gap: 16px; }
.new-request-field { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.new-request-field > label, .request-type-label { font-size: 13px; font-weight: 600; }
.request-type { display: flex; flex: 0 0 auto; flex-direction: column; gap: 10px; min-width: 0; }
.request-types { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.request-types label { display: flex; align-items: center; gap: 12px; cursor: pointer; font-size: 14px; }
.request-types input {
  appearance: none;
  -webkit-appearance: none;
  flex: 0 0 14px;
  width: 14px;
  height: 14px;
  margin: 0;
  border: 1px solid var(--muted);
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}
.request-types input:checked {
  border-color: var(--primary);
  background: radial-gradient(circle, var(--primary) 0 3px, transparent 3.5px);
}
.request-types input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 45%, transparent);
}
.request-types input:disabled { cursor: not-allowed; }
.new-request-field > .ui-input { height: 34px; border-radius: 6px; border-color: var(--border-strong); font-size: 13px; }
.new-request-url { display: flex; height: 34px; border: 1px solid var(--border-strong); border-radius: 6px; }
.new-request-url > .ui-select-trigger { min-width: 67px; height: 32px; border: 0; border-right: 1px solid var(--border-strong); border-radius: 5px 0 0 5px; padding: 0 10px; font-weight: 600; background: transparent; }
.new-request-url > .variable-input { flex: 1; width: 0; height: 32px; font-size: 13px; }
.new-request-url .variable-textbox { border: 0; padding: 0 12px; border-radius: 0 5px 5px 0; }
.new-request-url .variable-mirror { inset: 0; padding: 0 12px; }
.new-request-url:focus-within { border-color: var(--primary); }
.new-request-field > .curl-command { height: auto; min-height: 100px; resize: vertical; font-family: var(--font-code); font-size: 12px; line-height: 1.6; padding: 10px; }
.curl-preview { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px; background: var(--bg); border-radius: 4px; overflow-wrap: anywhere; }
.curl-preview small { flex-basis: 100%; color: var(--muted); }
.new-request-form .import-hint { font-size: 11px; line-height: 1.5; margin: 0; }
.new-request-dialog .modal-footer .ui-button { height: 30px; min-width: 72px; }
</style>
